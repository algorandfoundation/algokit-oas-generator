import { writeFile } from "node:fs/promises";
import SwaggerParser from "@apidevtools/swagger-parser";
import type {
  OpenAPISpec,
  OAS2Spec,
  ProcessingConfig,
  VendorExtensionTransform,
  FieldTransform,
  RequiredFieldTransform,
  SchemaRename,
  SchemaFieldRename,
  CustomSchema,
  FilterEndpoint,
  EndpointTagTransform,
  FixedLengthByteField,
} from "./types.js";
import { MISSING_DESCRIPTIONS, FIELD_RENAMES, BIGINT_FIELDS, FIXED_LENGTH_BYTE_FIELDS } from "./config.js";

// ===== TRAVERSAL UTILITIES =====

type TraverseVisitor = (obj: any, path: string[], parent: any | null, key: string | number | null) => void | "skip";

function deepTraverse(
  obj: any,
  visitor: TraverseVisitor,
  path: string[] = [],
  parent: any | null = null,
  key: string | number | null = null,
): void {
  if (!obj || typeof obj !== "object") return;
  const result = visitor(obj, path, parent, key);
  if (result === "skip") return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => deepTraverse(item, visitor, [...path, i.toString()], obj, i));
  } else {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object") {
        deepTraverse(v, visitor, [...path, k], obj, k);
      }
    }
  }
}

function forEachSchema(spec: OpenAPISpec, callback: (schemaName: string, schema: any) => void): void {
  const schemas = spec.components?.schemas;
  if (!schemas) return;
  for (const [name, schema] of Object.entries(schemas)) {
    if (schema && typeof schema === "object") {
      callback(name, schema);
    }
  }
}

function forEachSchemaProperty(
  spec: OpenAPISpec,
  callback: (schemaName: string, propName: string, propDef: any, schema: any) => void,
): void {
  forEachSchema(spec, (schemaName, schema) => {
    if (!schema.properties) return;
    for (const [propName, propDef] of Object.entries(schema.properties as Record<string, any>)) {
      if (propDef && typeof propDef === "object") {
        callback(schemaName, propName, propDef, schema);
      }
    }
  });
}

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options", "trace"] as const;

function forEachOperation(spec: OpenAPISpec, callback: (path: string, method: string, operation: any, pathObj: any) => void): void {
  if (!spec.paths) return;
  for (const [path, pathObj] of Object.entries(spec.paths)) {
    if (!pathObj || typeof pathObj !== "object") continue;
    for (const method of HTTP_METHODS) {
      const operation = (pathObj as any)[method];
      if (operation) callback(path, method, operation, pathObj);
    }
  }
}

function forEachParameter(
  spec: OpenAPISpec,
  callback: (path: string, method: string, param: any, paramIndex: number, operation: any) => void,
): void {
  forEachOperation(spec, (path, method, operation) => {
    if (!operation.parameters || !Array.isArray(operation.parameters)) return;
    operation.parameters.forEach((param: any, index: number) => {
      callback(path, method, param, index, operation);
    });
  });
}

function updateAllRefs(spec: OpenAPISpec, oldToNew: Record<string, string>): number {
  let count = 0;
  deepTraverse(spec, (obj) => {
    if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/components/schemas/")) {
      const refName = obj.$ref.substring("#/components/schemas/".length);
      if (oldToNew[refName]) {
        obj.$ref = `#/components/schemas/${oldToNew[refName]}`;
        count++;
      }
    }
  });
  return count;
}

// ===== TRANSFORMATIONS =====

/**
 * Pre-process OAS2 spec to move inline schemas to definitions.
 * This ensures the swagger converter preserves schema $refs instead of inlining them.
 */
export function extractInlineSchemas(spec: OAS2Spec): void {
  if (!spec.swagger) return;

  if (!spec.definitions) spec.definitions = {};

  if (spec.responses) {
    for (const [name, response] of Object.entries(spec.responses)) {
      if (response?.schema && !response.schema.$ref) {
        spec.definitions[name] = response.schema;
        response.schema = { $ref: `#/definitions/${name}` };
        console.log(`ℹ️  Extracted response schema: ${name}`);
      }
    }
  }

  if (spec.parameters) {
    for (const [name, param] of Object.entries(spec.parameters as Record<string, any>)) {
      if (param?.schema && !param.schema.$ref) {
        const schemaName = `${name}Body`;
        spec.definitions[schemaName] = param.schema;
        param.schema = { $ref: `#/definitions/${schemaName}` };
        console.log(`ℹ️  Extracted parameter schema: ${schemaName}`);
      }
    }
  }
}

/**
 * Find and fix missing descriptions in the spec
 */
function fixMissingDescriptions(spec: OpenAPISpec): number {
  let fixedCount = 0;
  const missingPaths: string[] = [];

  // Check component responses
  if (spec.components?.responses) {
    for (const [name, response] of Object.entries(spec.components.responses)) {
      if (response && typeof response === "object" && !response.description) {
        const path = `components.responses.${name}.description`;
        const description = MISSING_DESCRIPTIONS.get(path);

        if (description) {
          response.description = description;
          fixedCount++;
        } else {
          missingPaths.push(path);
        }
      }
    }
  }

  // Check path responses
  if (spec.paths) {
    for (const [pathName, pathObj] of Object.entries(spec.paths)) {
      if (!pathObj || typeof pathObj !== "object") continue;

      const methods = ["get", "post", "put", "delete", "patch", "head", "options", "trace"];

      for (const method of methods) {
        const operation = pathObj[method];
        if (!operation?.responses) continue;

        for (const [statusCode, response] of Object.entries(operation.responses)) {
          if (response && typeof response === "object" && !(response as any).description) {
            const path = `paths.'${pathName}'(${method}).responses.${statusCode}.description`;
            const description = MISSING_DESCRIPTIONS.get(path);

            if (description) {
              (response as any).description = description;
              fixedCount++;
            } else {
              missingPaths.push(path);
            }
          }
        }
      }
    }
  }

  // Report new missing descriptions
  if (missingPaths.length > 0) {
    console.warn(`⚠️  Found ${missingPaths.length} new missing descriptions:`);
    missingPaths.forEach((path) => console.warn(`  - ${path}`));
  }

  return fixedCount;
}

/**
 * Fix pydantic recursion error by removing format: byte from AvmValue schema
 */
function fixPydanticRecursionError(spec: OpenAPISpec): number {
  let fixedCount = 0;

  // Check if AvmValue schema exists
  if (spec.components?.schemas?.AvmValue) {
    const avmValue = spec.components.schemas.AvmValue;

    // Check if it has properties.bytes with format: "byte"
    if (avmValue.properties?.bytes?.format === "byte") {
      delete avmValue.properties.bytes.format;
      fixedCount++;
      console.log('ℹ️  Removed format: "byte" from AvmValue.properties.bytes to fix pydantic recursion error');
    }
  }

  return fixedCount;
}

/**
 * Transform vendor extensions throughout the spec
 */
function transformVendorExtensions(spec: OpenAPISpec, transforms: VendorExtensionTransform[]): Record<string, number> {
  const counts: Record<string, number> = {};
  transforms.forEach((t) => (counts[`${t.sourceProperty}:${t.sourceValue}`] = 0));

  deepTraverse(spec, (obj) => {
    for (const t of transforms) {
      if (obj[t.sourceProperty] === t.sourceValue) {
        obj[t.targetProperty] = t.targetValue;
        if (t.removeSource) delete obj[t.sourceProperty];
        counts[`${t.sourceProperty}:${t.sourceValue}`]++;
      }
    }
  });

  return counts;
}

/**
 * Fix field naming - Add field rename extensions for better ergonomics
 */
function fixFieldNaming(spec: OpenAPISpec): number {
  let fixedCount = 0;

  const findRename = (propName: string, schemaName?: string) =>
    FIELD_RENAMES.find((r) => r.from === propName && (!r.schemaName || r.schemaName === schemaName));

  // Process schema properties
  forEachSchemaProperty(spec, (schemaName, propName, propDef) => {
    const rename = findRename(propName, schemaName);
    if (rename) {
      propDef["x-algokit-field-rename"] = rename.to;
      fixedCount++;
    }
  });

  // Process inline response schemas
  deepTraverse(spec, (obj, path) => {
    if (path.length >= 2 && path[path.length - 1] === "properties" && path.includes("responses")) {
      for (const [propName, propDef] of Object.entries(obj as Record<string, any>)) {
        const rename = findRename(propName);
        if (rename && propDef && typeof propDef === "object") {
          (propDef as any)["x-algokit-field-rename"] = rename.to;
          fixedCount++;
        }
      }
    }
  });

  return fixedCount;
}

/**
 * Fix TealValue bytes - Add base64 extension for TealValue.bytes fields
 */
function fixTealValueBytes(spec: OpenAPISpec): number {
  let fixedCount = 0;
  forEachSchemaProperty(spec, (schemaName, propName, propDef) => {
    if (schemaName === "TealValue" && propName === "bytes") {
      propDef["x-algokit-bytes-base64"] = true;
      fixedCount++;
    }
  });
  return fixedCount;
}

/**
 * Fix bigint - Add x-algokit-bigint: true to properties that represent large integers
 */
function fixBigInt(spec: OpenAPISpec): number {
  let fixedCount = 0;

  const shouldMark = (fieldName: string, schemaName?: string) =>
    BIGINT_FIELDS.some((f) => f.fieldName === fieldName && (!f.excludedModels || !schemaName || !f.excludedModels.includes(schemaName)));

  // Process schema properties
  forEachSchemaProperty(spec, (schemaName, propName, propDef) => {
    if (propDef.type === "integer" && !propDef["x-algokit-bigint"] && shouldMark(propName, schemaName)) {
      propDef["x-algokit-bigint"] = true;
      fixedCount++;
    }
  });

  // Process parameters
  forEachParameter(spec, (_path, _method, param) => {
    const schema = param.schema;
    if (schema && schema.type === "integer" && !schema["x-algokit-bigint"] && shouldMark(param.name)) {
      schema["x-algokit-bigint"] = true;
      fixedCount++;
    }
  });

  // Process inline response schemas
  deepTraverse(spec, (obj, path) => {
    if (path.length >= 2 && path[path.length - 1] === "properties" && path.includes("responses")) {
      for (const [propName, propDef] of Object.entries(obj as Record<string, any>)) {
        if (propDef && typeof propDef === "object" && propDef.type === "integer" && !propDef["x-algokit-bigint"] && shouldMark(propName)) {
          propDef["x-algokit-bigint"] = true;
          fixedCount++;
        }
      }
    }
  });

  return fixedCount;
}

/**
 * Fix fixed-length byte arrays - Add x-algokit-byte-length to byte fields that have a known fixed length
 * This is similar to how js-algorand-sdk uses FixedLengthByteArraySchema(32) for 32-byte fields
 */
function fixFixedLengthByteFields(spec: OpenAPISpec, fields: FixedLengthByteField[]): number {
  let fixedCount = 0;

  const findByteLength = (fieldName: string, schemaName?: string) =>
    fields.find((f) => f.fieldName === fieldName && (!f.schemaName || f.schemaName === schemaName));

  // Process schema properties
  forEachSchemaProperty(spec, (schemaName, propName, propDef) => {
    // Only apply to byte format string fields
    if (propDef.type === "string" && propDef.format === "byte" && !propDef["x-algokit-byte-length"]) {
      const field = findByteLength(propName, schemaName);
      if (field) {
        propDef["x-algokit-byte-length"] = field.byteLength;
        fixedCount++;
      }
    }
  });

  // Process inline response schemas
  deepTraverse(spec, (obj, path) => {
    if (path.length >= 2 && path[path.length - 1] === "properties" && path.includes("responses")) {
      for (const [propName, propDef] of Object.entries(obj as Record<string, any>)) {
        if (
          propDef &&
          typeof propDef === "object" &&
          propDef.type === "string" &&
          propDef.format === "byte" &&
          !propDef["x-algokit-byte-length"]
        ) {
          const field = findByteLength(propName);
          if (field) {
            propDef["x-algokit-byte-length"] = field.byteLength;
            fixedCount++;
          }
        }
      }
    }
  });

  return fixedCount;
}

/**
 * Transform specific properties by removing configured items and/or adding new items
 */
function transformProperties(spec: OpenAPISpec, transforms: FieldTransform[]): number {
  let transformedCount = 0;

  if (!transforms?.length) {
    return transformedCount;
  }

  const processObject = (obj: any, currentPath: string[] = [], parent: any = null): void => {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      obj.forEach((item, index) => processObject(item, [...currentPath, index.toString()], obj));
      return;
    }

    // Check each configured transformation
    for (const transform of transforms) {
      const fullPath = currentPath.join(".");

      // Handle dot-notation in fieldName (e.g., "account-id.schema" or "foreign-assets.items")
      const fieldParts = transform.fieldName.split(".");
      const baseName = fieldParts[0];

      // Build possible match patterns
      const targetPath = `properties.${transform.fieldName}`;
      const parameterPath = `components.parameters.${transform.fieldName}`;

      // Check if current path matches the target property path or parameter path
      const isPropertyMatch = fullPath.endsWith(targetPath);
      const isParameterMatch = fullPath.endsWith(parameterPath);

      // Check if this is an inline parameter with matching name
      let isInlineParameterMatch = false;
      if (fieldParts.length === 1 && obj.name === baseName) {
        // Simple case: the object itself has name="account-id"
        isInlineParameterMatch = true;
      } else if (fieldParts.length === 2 && parent && parent.name === baseName) {
        // Nested case: parent has name="account-id" and we're at the nested property (e.g., "schema")
        const lastPathPart = currentPath[currentPath.length - 1];
        if (lastPathPart === fieldParts[1]) {
          isInlineParameterMatch = true;
        }
      }

      if (isPropertyMatch || isParameterMatch || isInlineParameterMatch) {
        // If schemaName is specified, check if we're in the correct schema context
        // (only applies to properties, not parameters)
        if (transform.schemaName && isPropertyMatch) {
          const schemaPath = `components.schemas.${transform.schemaName}.properties.${transform.fieldName}`;
          if (!fullPath.endsWith(schemaPath)) {
            continue; // Skip this transform if not in the specified schema
          }
        }

        // Remove specified items from this property/parameter
        if (transform.removeItems) {
          for (const itemToRemove of transform.removeItems) {
            if (obj.hasOwnProperty(itemToRemove)) {
              delete obj[itemToRemove];
              transformedCount++;
            }
          }
        }

        // Add specified items to this property/parameter
        if (transform.addItems) {
          for (const [key, value] of Object.entries(transform.addItems)) {
            obj[key] = value;
            transformedCount++;
          }
        }
      }
    }

    // Recursively process nested objects
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === "object") {
        processObject(value, [...currentPath, key], obj);
      }
    }
  };

  processObject(spec);
  return transformedCount;
}

/**
 * Transform required fields in schemas
 *
 * This function adds or removes specified fields from the 'required' array of OpenAPI schemas.
 * If the required array becomes empty after removals, it's removed entirely.
 */
function transformRequiredFields(spec: OpenAPISpec, transforms: RequiredFieldTransform[]): number {
  let transformedCount = 0;

  forEachSchema(spec, (schemaName, schema) => {
    for (const transform of transforms) {
      if (transform.schemaName !== schemaName) continue;

      const fieldNames = Array.isArray(transform.fieldName) ? transform.fieldName : [transform.fieldName];

      for (const fieldName of fieldNames) {
        if (!schema.properties?.[fieldName]) continue;

        if (!schema.required) schema.required = [];

        if (transform.makeRequired && !schema.required.includes(fieldName)) {
          schema.required.push(fieldName);
          transformedCount++;
        } else if (!transform.makeRequired && schema.required.includes(fieldName)) {
          schema.required = schema.required.filter((f: string) => f !== fieldName);
          if (schema.required.length === 0) {
            delete schema.required;
          }
          transformedCount++;
        }
      }
    }
  });

  return transformedCount;
}

/**
 * Enforce a single endpoint format (json or msgpack) by stripping the opposite one
 */
function enforceEndpointFormat(spec: OpenAPISpec, endpoints: FilterEndpoint[], targetFormat: "json" | "msgpack"): number {
  let modifiedCount = 0;

  if (!spec.paths || !endpoints?.length) {
    return modifiedCount;
  }

  const targetContentType = targetFormat === "json" ? "application/json" : "application/msgpack";
  const otherContentType = targetFormat === "json" ? "application/msgpack" : "application/json";

  for (const endpoint of endpoints) {
    const pathObj = spec.paths[endpoint.path];
    if (!pathObj) {
      console.warn(`⚠️  Path ${endpoint.path} not found in spec`);
      continue;
    }

    const methods = endpoint.methods || ["get"];

    for (const method of methods) {
      const operation = pathObj[method];
      if (!operation) {
        continue;
      }

      // Query parameter: format
      if (operation.parameters && Array.isArray(operation.parameters)) {
        for (const param of operation.parameters) {
          const paramObj = param.$ref ? resolveRef(spec, param.$ref) : param;
          if (paramObj && paramObj.name === "format" && paramObj.in === "query") {
            const schemaObj = paramObj.schema || paramObj;
            if (schemaObj.enum && Array.isArray(schemaObj.enum)) {
              const values: string[] = schemaObj.enum;
              if (values.includes("json") || values.includes("msgpack")) {
                if (values.length !== 1 || values[0] !== targetFormat) {
                  schemaObj.enum = [targetFormat];
                  if (schemaObj.default !== targetFormat) schemaObj.default = targetFormat;
                  modifiedCount++;
                  console.log(`ℹ️  Enforced ${targetFormat}-only for ${endpoint.path} (${method}) parameter`);
                }
              }
            } else if (schemaObj.type === "string" && !schemaObj.enum) {
              schemaObj.enum = [targetFormat];
              schemaObj.default = targetFormat;
              modifiedCount++;
              console.log(`ℹ️  Enforced ${targetFormat}-only for ${endpoint.path} (${method}) parameter`);
            }
          }
        }
      }

      // Request body content types
      if (operation.requestBody && typeof operation.requestBody === "object") {
        const rbRaw: any = operation.requestBody;
        const rb: any = rbRaw.$ref ? resolveRef(spec, rbRaw.$ref) || rbRaw : rbRaw;
        if (rb && rb.content && rb.content[otherContentType] && rb.content[targetContentType]) {
          delete rb.content[otherContentType];
          modifiedCount++;
          console.log(`ℹ️  Removed ${otherContentType} request content-type for ${endpoint.path} (${method})`);
        }
      }

      // Response content types
      if (operation.responses) {
        for (const [statusCode, response] of Object.entries(operation.responses)) {
          if (response && typeof response === "object") {
            const responseObj = response as any;
            const responseTarget: any = responseObj.$ref ? resolveRef(spec, responseObj.$ref) || responseObj : responseObj;
            if (
              responseTarget &&
              responseTarget.content &&
              responseTarget.content[otherContentType] &&
              responseTarget.content[targetContentType]
            ) {
              delete responseTarget.content[otherContentType];
              modifiedCount++;
              console.log(`ℹ️  Removed ${otherContentType} response content-type for ${endpoint.path} (${method}) - ${statusCode}`);
            }
          }
        }
      }
    }
  }

  return modifiedCount;
}

/**
 * Helper function to resolve $ref references in the spec
 */
function resolveRef(spec: OpenAPISpec, ref: string): any {
  if (!ref.startsWith("#/")) {
    return null;
  }

  const parts = ref.substring(2).split("/");
  let current: any = spec;

  for (const part of parts) {
    current = current?.[part];
    if (!current) {
      return null;
    }
  }

  return current;
}

/**
 * Create a new custom schema and add it to the OpenAPI spec
 */
function createCustomSchema(spec: OpenAPISpec, schemaName: string, schemaDefinition: any): number {
  let createdCount = 0;

  if (!spec.components) {
    spec.components = {};
  }
  if (!spec.components.schemas) {
    spec.components.schemas = {};
  }

  // Only add if it doesn't already exist
  if (!spec.components.schemas[schemaName]) {
    spec.components.schemas[schemaName] = schemaDefinition;
    createdCount++;
    console.log(`ℹ️  Created new schema: ${schemaName}`);
  } else {
    console.warn(`⚠️  Schema ${schemaName} already exists, skipping creation`);
  }

  return createdCount;
}

/**
 * Update property references to use a custom schema
 */
function linkSchemaToProperties(spec: OpenAPISpec, customSchemas: CustomSchema[]): number {
  let linkedCount = 0;

  for (const customSchema of customSchemas) {
    deepTraverse(spec, (obj) => {
      if (obj.properties) {
        for (const [propName, propDef] of Object.entries(obj.properties as Record<string, any>)) {
          if (
            customSchema.linkToProperties &&
            customSchema.linkToProperties.includes(propName) &&
            propDef &&
            typeof propDef === "object" &&
            !propDef.$ref
          ) {
            obj.properties[propName] = { $ref: `#/components/schemas/${customSchema.name}` };
            linkedCount++;
          }
        }
      }
    });
  }

  return linkedCount;
}

/**
 * Add vendor extensions to specific schemas
 */
function addSchemaVendorExtensions(spec: OpenAPISpec, schemaExtensions: { schemaName: string; extension: string; value: any }[]): number {
  let addedCount = 0;

  forEachSchema(spec, (schemaName, schema) => {
    for (const ext of schemaExtensions) {
      if (ext.schemaName === schemaName) {
        schema[ext.extension] = ext.value;
        addedCount++;
      }
    }
  });

  return addedCount;
}

/**
 * Rename component schemas and update all $ref usages according to configuration.
 * Adds x-algokit-original-name metadata for traceability.
 */
function renameSchemas(spec: OpenAPISpec, renames: SchemaRename[]): number {
  if (!spec.components?.schemas) return 0;
  let renamedCount = 0;
  const refUpdates: Record<string, string> = {};
  const renameMap = new Map(renames.map((r) => [r.from, r.to]));
  const newSchemas: Record<string, any> = {};

  // Build new schemas object with renames applied, preserving order
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    const newName = renameMap.get(name);
    if (newName) {
      schema["x-algokit-original-name"] = name;
      if (schema.description && typeof schema.description === "string") {
        schema.description = schema.description.replace(new RegExp(name, "g"), newName).replace(/\nfriendly:.+$/, "");
      }
      newSchemas[newName] = schema;
      refUpdates[name] = newName;
      renamedCount++;
    } else {
      newSchemas[name] = schema;
    }
  }

  spec.components.schemas = newSchemas;

  // Update all $ref references
  updateAllRefs(spec, refUpdates);

  return renamedCount;
}

/**
 * Rename fields within schemas (actual field name changes, not just metadata)
 */
function renameSchemaFields(spec: OpenAPISpec, schemaFieldRenames: SchemaFieldRename[]): number {
  let renamedCount = 0;

  forEachSchema(spec, (schemaName, schema) => {
    const config = schemaFieldRenames.find((c) => c.schemaName === schemaName);
    if (!config || !schema.properties) return;

    for (const rename of config.fieldRenames) {
      if (schema.properties[rename.from]) {
        schema.properties[rename.to] = schema.properties[rename.from];
        delete schema.properties[rename.from];

        if (schema.required && Array.isArray(schema.required)) {
          const idx = schema.required.indexOf(rename.from);
          if (idx !== -1) schema.required[idx] = rename.to;
        }
        renamedCount++;
      }
    }
  });

  return renamedCount;
}

/**
 * Remove specified fields from all schemas in the spec
 */
function removeSchemaFields(spec: OpenAPISpec, fieldsToRemove: string[]): number {
  let removedCount = 0;

  forEachSchema(spec, (_schemaName, schema) => {
    if (!schema.properties) return;
    for (const field of fieldsToRemove) {
      if (schema.properties[field]) {
        delete schema.properties[field];
        if (schema.required && Array.isArray(schema.required)) {
          schema.required = schema.required.filter((f: string) => f !== field);
          if (schema.required.length === 0) {
            delete schema.required;
          }
        }
        removedCount++;
      }
    }
  });

  return removedCount;
}

/**
 * Make all properties required in all schemas
 */
function makeAllFieldsRequired(spec: OpenAPISpec): number {
  let addedCount = 0;

  forEachSchema(spec, (_schemaName, schema) => {
    if (!schema.properties) return;
    const propNames = Object.keys(schema.properties);
    if (!schema.required) schema.required = [];

    for (const propName of propNames) {
      if (!schema.required.includes(propName)) {
        schema.required.push(propName);
        addedCount++;
      }
    }
  });

  return addedCount;
}

/**
 * Transform endpoint tags by adding or removing tags from specific endpoints
 */
function transformEndpointTags(spec: OpenAPISpec, transforms: EndpointTagTransform[]): number {
  let transformedCount = 0;

  forEachOperation(spec, (path, method, operation) => {
    for (const transform of transforms) {
      if (transform.path !== path) continue;
      if (transform.methods && !transform.methods.includes(method)) continue;

      if (!operation.tags) operation.tags = [];

      // Remove tags if specified
      if (transform.removeTags && transform.removeTags.length > 0) {
        const originalLength = operation.tags.length;
        operation.tags = operation.tags.filter((tag: string) => !transform.removeTags!.includes(tag));
        transformedCount += originalLength - operation.tags.length;
      }

      // Add tags if specified
      if (transform.addTags && transform.addTags.length > 0) {
        for (const tag of transform.addTags) {
          if (!operation.tags.includes(tag)) {
            operation.tags.push(tag);
            transformedCount++;
          }
        }
      }
    }
  });

  return transformedCount;
}

/**
 * Remove schemas that have no properties and update all references to them
 */
function removeEmptySchemas(spec: OpenAPISpec): number {
  if (!spec.components?.schemas) return 0;

  const emptySchemas = new Set<string>();

  // Find empty schemas (schemas with properties object but no properties in it)
  forEachSchema(spec, (schemaName, schema) => {
    if (schema.properties && typeof schema.properties === "object" && Object.keys(schema.properties).length === 0) {
      emptySchemas.add(schemaName);
    }
  });

  if (emptySchemas.size === 0) return 0;

  // Replace references to empty schemas - just remove the $ref
  deepTraverse(spec, (obj) => {
    if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/components/schemas/")) {
      const refName = obj.$ref.substring("#/components/schemas/".length);
      if (emptySchemas.has(refName)) {
        delete obj.$ref;
      }
    }
  });

  // Clean up empty content objects in responses
  deepTraverse(spec, (obj, path) => {
    // Check if this is a response object with content
    if (obj.content && typeof obj.content === "object" && path.includes("responses")) {
      // Check each media type in content
      for (const [mediaType, mediaTypeObj] of Object.entries(obj.content)) {
        if (mediaTypeObj && typeof mediaTypeObj === "object") {
          const schema = (mediaTypeObj as any).schema;
          // If schema exists but is empty (no properties), remove this media type
          if (schema && typeof schema === "object" && !schema.$ref && Object.keys(schema).length === 0) {
            delete obj.content[mediaType];
          }
        }
      }
      // If content is now empty, leave it as empty object (this matches original behavior)
    }
  });

  // Handle allOf with empty schema refs
  deepTraverse(spec, (obj) => {
    if (obj.allOf && Array.isArray(obj.allOf)) {
      obj.allOf = obj.allOf.filter((item: any) => {
        if (item.$ref && typeof item.$ref === "string") {
          const refName = item.$ref.substring("#/components/schemas/".length);
          return !emptySchemas.has(refName);
        }
        return true;
      });
      if (obj.allOf.length === 0) delete obj.allOf;
      else if (obj.allOf.length === 1 && !obj.properties) {
        const single = obj.allOf[0];
        delete obj.allOf;
        Object.assign(obj, single);
      }
    }
  });

  // Remove empty schemas
  for (const schemaName of emptySchemas) {
    delete spec.components.schemas[schemaName];
  }

  return emptySchemas.size;
}

// ===== MAIN PROCESSOR =====

export class OpenAPIProcessor {
  constructor(private config: ProcessingConfig) {}

  /**
   * Apply typo fixes to raw JSON content
   */
  private patchTypos(content: string): string {
    const patches = [
      ["ana ccount", "an account"],
      ["since eposh", "since epoch"],
      ["* update\\n* update\\n* delete", "* update\\n* delete"],
      ["APIV1POSTWalletRenameRequest is the", "The"],
      ["APIV1POSTWalletRequest is the", "The"],
      ["APIV1DELETEKeyRequest is the", "The"],
      ["APIV1DELETEMultisigRequest is the", "The"],
      ["APIV1POSTKeyExportRequest is the", "The"],
      ["APIV1POSTMasterKeyExportRequest is the", "The"],
      ["APIV1POSTMultisigExportRequest is the", "The"],
      ["APIV1POSTKeyRequest is the", "The"],
      ["APIV1POSTKeyImportRequest is the", "The"],
      ["APIV1POSTMultisigImportRequest is the", "The"],
      ["APIV1POSTWalletInitRequest is the", "The"],
      ["APIV1POSTKeyListRequest is the", "The"],
      ["APIV1POSTMultisigListRequest is the", "The"],
      ["APIV1POSTWalletReleaseRequest is the", "The"],
      ["APIV1POSTWalletRenameRequest is the", "The"],
      ["APIV1POSTWalletRenewRequest is the", "The"],
      ["APIV1POSTMultisigTransactionSignRequest is the", "The"],
      ["APIV1POSTProgramSignRequest is the", "The"],
      ["APIV1POSTTransactionSignRequest is the", "The"],
      ["APIV1POSTWalletInfoRequest is the", "The"],
      ["APIV1POSTMultisigProgramSignRequest is the", "The"],
    ];

    return patches.reduce((text, [find, replace]) => text.replaceAll(find, replace), content);
  }

  /**
   * Fetch spec from URL or file
   */
  private async fetchSpec(): Promise<OpenAPISpec> {
    console.log(`ℹ️  Fetching OpenAPI spec from ${this.config.sourceUrl}...`);

    // Check if it's a file path or URL
    if (this.config.sourceUrl.startsWith("http://") || this.config.sourceUrl.startsWith("https://")) {
      const response = await fetch(this.config.sourceUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch spec: ${response.status} ${response.statusText}`);
      }
      const rawContent = await response.text();
      const patchedContent = this.patchTypos(rawContent);
      const spec = JSON.parse(patchedContent);
      console.log("✅ Successfully fetched OpenAPI specification");
      return spec;
    } else {
      // Local file
      const spec = await SwaggerParser.parse(this.config.sourceUrl);
      console.log("✅ Successfully loaded OpenAPI specification from file");
      return spec as OpenAPISpec;
    }
  }

  /**
   * Convert Swagger 2.0 to OpenAPI 3.0
   */
  private async convertToOpenAPI3(spec: OpenAPISpec): Promise<OpenAPISpec> {
    if (!spec.swagger || spec.openapi) {
      console.log("ℹ️  Specification is already OpenAPI 3.0");
      return spec;
    }

    const endpoint = this.config.converterEndpoint || "https://converter.swagger.io/api/convert";
    console.log("ℹ️  Converting Swagger 2.0 to OpenAPI 3.0...");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(spec),
    });

    if (!response.ok) {
      throw new Error(`Conversion failed: ${response.status} ${response.statusText}`);
    }

    const converted = await response.json();
    console.log("✅ Successfully converted to OpenAPI 3.0");
    return converted;
  }

  /**
   * Save spec to file
   */
  private async saveSpec(spec: OpenAPISpec): Promise<void> {
    const indent = this.config.indent || 2;
    const content = JSON.stringify(spec, null, indent);

    await writeFile(this.config.outputPath, content, "utf8");
    console.log(`✅ Specification saved to ${this.config.outputPath}`);
  }

  /**
   * Process the OpenAPI specification
   */
  async process(): Promise<void> {
    try {
      console.log("ℹ️  Starting OpenAPI processing...");

      // Fetch and parse the spec
      let spec = await this.fetchSpec();

      // Pre-process OAS2 to prevent swagger converter from inlining response schemas
      extractInlineSchemas(spec as OAS2Spec);

      // Convert to OpenAPI 3.0 if needed
      spec = await this.convertToOpenAPI3(spec);

      // Validate the spec
      console.log("ℹ️  Validating OpenAPI specification...");

      // Apply transformations
      console.log("ℹ️  Applying transformations...");
      // Rename schemas if configured (e.g., strip APIVn prefixes from KMD)
      if (this.config.schemaRenames && this.config.schemaRenames.length > 0) {
        const renamed = renameSchemas(spec, this.config.schemaRenames);
        if (renamed > 0) {
          console.log(`ℹ️  Renamed ${renamed} schemas`);
        }
      }

      // Rename schema fields if configured (e.g., MultisigSig field names in KMD)
      if (this.config.schemaFieldRenames && this.config.schemaFieldRenames.length > 0) {
        const renamedCount = renameSchemaFields(spec, this.config.schemaFieldRenames);
        console.log(`ℹ️  Renamed ${renamedCount} fields in schemas`);
      }

      // Remove specified schema fields if configured (KMD error/message cleanup)
      if (this.config.removeSchemaFields && this.config.removeSchemaFields.length > 0) {
        const removedCount = removeSchemaFields(spec, this.config.removeSchemaFields);
        console.log(`ℹ️  Removed ${removedCount} fields from schemas`);

        // After removing properties, check for and remove schemas that now have no properties
        const removedSchemas = removeEmptySchemas(spec);
        if (removedSchemas > 0) {
          console.log(`ℹ️  Removed ${removedSchemas} empty schemas`);
        }
      }

      // Fix missing descriptions
      const descriptionCount = fixMissingDescriptions(spec);
      console.log(`ℹ️  Fixed ${descriptionCount} missing descriptions`);

      // Fix pydantic recursion error
      const pydanticCount = fixPydanticRecursionError(spec);
      console.log(`ℹ️  Fixed ${pydanticCount} pydantic recursion errors`);

      // Fix field naming
      const fieldNamingCount = fixFieldNaming(spec);
      console.log(`ℹ️  Added field rename extensions to ${fieldNamingCount} properties`);

      // Fix TealValue bytes fields
      const tealValueCount = fixTealValueBytes(spec);
      console.log(`ℹ️  Added bytes base64 extensions to ${tealValueCount} TealValue.bytes properties`);

      // Fix bigint properties
      const bigIntCount = fixBigInt(spec);
      console.log(`ℹ️  Added x-algokit-bigint to ${bigIntCount} properties`);

      // Fix fixed-length byte array fields
      const fixedByteFields = this.config.fixedLengthByteFields ?? FIXED_LENGTH_BYTE_FIELDS;
      if (fixedByteFields.length > 0) {
        const fixedByteCount = fixFixedLengthByteFields(spec, fixedByteFields);
        console.log(`ℹ️  Added x-algokit-byte-length to ${fixedByteCount} byte fields`);
      }

      // Make all fields required if configured
      if (this.config.makeAllFieldsRequired) {
        const madeRequiredCount = makeAllFieldsRequired(spec);
        console.log(`ℹ️  Made ${madeRequiredCount} fields required across all schemas`);
      }

      // Transform required fields if configured
      let transformedFieldsCount = 0;
      if (this.config.requiredFieldTransforms && this.config.requiredFieldTransforms.length > 0) {
        transformedFieldsCount = transformRequiredFields(spec, this.config.requiredFieldTransforms);
        console.log(`ℹ️  Transformed ${transformedFieldsCount} required field states`);
      }

      // Transform properties if configured
      let transformedPropertiesCount = 0;
      if (this.config.fieldTransforms && this.config.fieldTransforms.length > 0) {
        transformedPropertiesCount = transformProperties(spec, this.config.fieldTransforms);
        console.log(`ℹ️  Applied ${transformedPropertiesCount} property transformations (additions/removals)`);
      }

      // Transform vendor extensions if configured
      if (this.config.vendorExtensionTransforms && this.config.vendorExtensionTransforms.length > 0) {
        const transformCounts = transformVendorExtensions(spec, this.config.vendorExtensionTransforms);

        for (const [countKey, count] of Object.entries(transformCounts)) {
          const [sourceProperty, sourceValue] = countKey.split(":");
          const transform = this.config.vendorExtensionTransforms.find(
            (t) => t.sourceProperty === sourceProperty && t.sourceValue === sourceValue,
          );
          if (transform) {
            console.log(`ℹ️  Transformed ${count} ${sourceProperty}: ${sourceValue} to ${transform.targetProperty}`);
          }
        }
      }

      // Enforce msgpack-only endpoints if configured
      if (this.config.msgpackOnlyEndpoints && this.config.msgpackOnlyEndpoints.length > 0) {
        const msgpackCount = enforceEndpointFormat(spec, this.config.msgpackOnlyEndpoints, "msgpack");
        console.log(`ℹ️  Enforced msgpack-only format for ${msgpackCount} endpoint parameters/responses`);
      }

      // Enforce json-only endpoints if configured
      if (this.config.jsonOnlyEndpoints && this.config.jsonOnlyEndpoints.length > 0) {
        const jsonCount = enforceEndpointFormat(spec, this.config.jsonOnlyEndpoints, "json");
        console.log(`ℹ️  Enforced json-only format for ${jsonCount} endpoint parameters/responses`);
      }

      // Create custom schemas if configured
      if (this.config.customSchemas && this.config.customSchemas.length > 0) {
        let customSchemaCount = 0;
        for (const customSchema of this.config.customSchemas) {
          customSchemaCount += createCustomSchema(spec, customSchema.name, customSchema.schema);
        }
        console.log(`ℹ️  Created ${customSchemaCount} custom schemas`);

        // Link properties to custom schemas
        const linkedPropertiesCount = linkSchemaToProperties(spec, this.config.customSchemas);
        if (linkedPropertiesCount > 0) {
          console.log(`ℹ️  Linked ${linkedPropertiesCount} properties to custom schemas`);
        }
      }

      // Add vendor extensions to specific schemas if configured
      if (this.config.schemaVendorExtensions && this.config.schemaVendorExtensions.length > 0) {
        const extensionCount = addSchemaVendorExtensions(spec, this.config.schemaVendorExtensions);
        if (extensionCount > 0) {
          console.log(`ℹ️  Added ${extensionCount} vendor extensions to schemas`);
        }
      }

      // Transform endpoint tags if configured
      if (this.config.endpointTagTransforms && this.config.endpointTagTransforms.length > 0) {
        const tagCount = transformEndpointTags(spec, this.config.endpointTagTransforms);
        console.log(`ℹ️  Applied ${tagCount} endpoint tag transformations`);
      }

      // Save the processed spec
      await SwaggerParser.validate(JSON.parse(JSON.stringify(spec)));
      console.log("✅ Specification is valid");

      await this.saveSpec(spec);

      console.log("✅ OpenAPI processing completed successfully!");
      console.log(`📄 Source: ${this.config.sourceUrl}`);
      console.log(`📄 Output: ${this.config.outputPath}`);
    } catch (error) {
      console.error(`❌ Processing failed: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }
}
