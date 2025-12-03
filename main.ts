#!/usr/bin/env node

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { fileURLToPath } from "node:url";
import { format } from "node:path";

// ===== TYPES =====

interface OpenAPISpec {
  openapi?: string;
  swagger?: string;
  info?: any;
  paths?: Record<string, any>;
  components?: {
    schemas?: Record<string, any>;
    responses?: Record<string, any>;
    parameters?: Record<string, any>;
    [key: string]: any;
  };
  [key: string]: any;
}

interface VendorExtensionTransform {
  sourceProperty: string; // e.g., "x-algorand-format" or "format"
  sourceValue: string; // e.g., "uint64"
  targetProperty: string; // e.g., "x-algokit-bigint"
  targetValue: boolean | string; // value to set
  removeSource?: boolean; // whether to remove the source property (default false)
}

interface RequiredFieldTransform {
  schemaName: string; // e.g., "ApplicationParams" - The OpenAPI schema name
  fieldName: string | string[]; // e.g., "approval-program" or ["approval-program", "clear-state-program"] - The field name(s) to transform
  makeRequired: boolean; // true = add to required array, false = remove from required array
}

interface FieldTransform {
  fieldName: string; // e.g., "action"
  schemaName?: string; // Optional: specific schema name to target, e.g., "TealKeyValue"
  removeItems?: string[]; // properties to remove from the target property, e.g., ["format"]
  addItems?: Record<string, any>; // properties to add to the target property, e.g., {"x-custom": true}
}

interface FilterEndpoint {
  path: string; // Exact path to match (e.g., "/v2/blocks/{round}")
  methods?: string[]; // HTTP methods to apply to (default: ["get"])
}

interface FieldRename {
  from: string; // Original field name
  to: string; // New field name
  schemaName?: string; // Optional: specific schema name to target
}

interface CustomSchema {
  name: string; // Schema name
  schema: Record<string, unknown>; // Schema definition object
  linkToProperties?: string[]; // Optional: property names to update with this schema reference
}

interface SchemaRename {
  from: string; // Original schema name
  to: string; // New schema name
}

interface SchemaFieldRename {
  schemaName: string; // Schema name to target
  fieldRenames: { from: string; to: string }[]; // Field renames to apply
}

interface EndpointTagTransform {
  path: string; // Exact path to match (e.g., "/v2/teal/dryrun")
  methods?: string[]; // HTTP methods to apply to (default: all methods on the path)
  addTags?: string[]; // Tags to add to the endpoint
  removeTags?: string[]; // Tags to remove from the endpoint
}

interface ProcessingConfig {
  sourceUrl: string;
  outputPath: string;
  converterEndpoint?: string;
  indent?: number;
  vendorExtensionTransforms?: VendorExtensionTransform[];
  requiredFieldTransforms?: RequiredFieldTransform[];
  fieldTransforms?: FieldTransform[];
  msgpackOnlyEndpoints?: FilterEndpoint[];
  jsonOnlyEndpoints?: FilterEndpoint[];
  customSchemas?: CustomSchema[];
  // Schema renames to apply
  schemaRenames?: SchemaRename[];
  // Schema field renames to apply (actual field name changes)
  schemaFieldRenames?: SchemaFieldRename[];
  // Field names to remove from all schemas (e.g., ["error", "message"])
  removeSchemaFields?: string[];
  // Make all properties required in all schemas
  makeAllFieldsRequired?: boolean;
  // Endpoint tag transforms to add/remove tags from specific endpoints
  endpointTagTransforms?: EndpointTagTransform[];
}

// ===== OAS2 PRE-PROCESSING =====

interface OAS2Spec {
  swagger?: string;
  definitions?: Record<string, any>;
  responses?: Record<string, any>;
  parameters?: Record<string, any>;
  [key: string]: any;
}

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

// ===== TRANSFORMATIONS =====

// Known missing descriptions to auto-fix
const MISSING_DESCRIPTIONS = new Map([
  // Component responses
  ["components.responses.NodeStatusResponse.description", "Returns the current status of the node"],
  ["components.responses.CatchpointStartResponse.description", "Catchpoint start operation response"],
  ["components.responses.CatchpointAbortResponse.description", "Catchpoint abort operation response"],

  // Path responses
  ["paths.'/v2/transactions/async'(post).responses.200.description", "Transaction successfully submitted for asynchronous processing"],
  ["paths.'/v2/status'(get).responses.200.description", "Returns the current node status including sync status, version, and latest round"],
  ["paths.'/v2/catchup/{catchpoint}'(post).responses.200.description", "Catchpoint operation started successfully"],
  ["paths.'/v2/catchup/{catchpoint}'(post).responses.201.description", "Catchpoint operation created and started successfully"],
  ["paths.'/v2/catchup/{catchpoint}'(delete).responses.200.description", "Catchpoint operation aborted successfully"],
  ["paths.'/v2/ledger/sync/{round}'(post).responses.200.description", "Ledger sync to specified round initiated successfully"],
  ["paths.'/v2/shutdown'(post).responses.200.description", "Node shutdown initiated successfully"],
  [
    "paths.'/v2/status/wait-for-block-after/{round}'(get).responses.200.description",
    "Returns node status after the specified round is reached",
  ],
  ["paths.'/v2/ledger/sync'(delete).responses.200.description", "Ledger sync operation stopped successfully"],
]);

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
  const transformCounts: Record<string, number> = {};

  // Initialize counts
  transforms.forEach((t) => (transformCounts[`${t.sourceProperty}:${t.sourceValue}`] = 0));

  const transform = (obj: any): void => {
    if (!obj || typeof obj !== "object") return;

    // Check each configured transformation
    for (const transform of transforms) {
      if (obj[transform.sourceProperty] === transform.sourceValue) {
        // Add/set the target property
        obj[transform.targetProperty] = transform.targetValue;

        // Remove source property if configured to do so
        if (transform.removeSource) {
          delete obj[transform.sourceProperty];
        }

        // Increment count
        const countKey = `${transform.sourceProperty}:${transform.sourceValue}`;
        transformCounts[countKey]++;
      }
    }

    // Recursively process all properties
    if (Array.isArray(obj)) {
      obj.forEach((item) => transform(item));
    } else {
      Object.keys(obj).forEach((key) => transform(obj[key]));
    }
  };

  transform(spec);
  return transformCounts;
}

/**
 * Fix field naming - Add field rename extensions for better ergonomics
 */
function fixFieldNaming(spec: OpenAPISpec): number {
  let fixedCount = 0;

  // Properties that should be renamed for better developer experience
  const fieldRenames: FieldRename[] = [
    { from: "application-index", to: "app_id" },
    { from: "app-index", to: "app_id" },
    { from: "created-application-index", to: "created_app_id" },
    { from: "asset-index", to: "asset_id" },
    { from: "created-asset-index", to: "created_asset_id" },
    { from: "index", to: "id", schemaName: "Asset" },
    { from: "blockTxids", to: "block_tx_ids" },
  ];

  const processObject = (obj: any, schemaName?: string): void => {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      obj.forEach((o) => processObject(o, schemaName));
      return;
    }

    // Process schemas and track schema names
    if (obj.schemas && typeof obj.schemas === "object") {
      for (const [name, schemaDef] of Object.entries(obj.schemas)) {
        processObject(schemaDef, name);
      }
    }

    // Process responses and track response names
    if (obj.responses && typeof obj.responses === "object") {
      for (const [name, responseDef] of Object.entries(obj.responses)) {
        processObject(responseDef, name);
      }
    }

    // If we processed either schemas or responses, return early to avoid double processing
    if ((obj.schemas && typeof obj.schemas === "object") || (obj.responses && typeof obj.responses === "object")) {
      return;
    }

    // Look for properties object in schemas
    if (obj.properties && typeof obj.properties === "object") {
      for (const [propName, propDef] of Object.entries(obj.properties as Record<string, any>)) {
        if (propDef && typeof propDef === "object") {
          const rename = fieldRenames.find((r) => {
            // Check if field name matches
            if (r.from !== propName) return false;

            // If rename has a schema restriction, check if we're in the correct schema
            if (r.schemaName && r.schemaName !== schemaName) return false;

            return true;
          });

          if (rename) {
            propDef["x-algokit-field-rename"] = rename.to;
            fixedCount++;
          }
        }
      }
    }

    // Recursively process nested objects (preserve schema name context)
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        processObject(value, schemaName);
      }
    }
  };

  processObject(spec);
  return fixedCount;
}

/**
 * Fix TealValue bytes - Add base64 extension for TealValue.bytes fields
 */
function fixTealValueBytes(spec: OpenAPISpec): number {
  let fixedCount = 0;

  const processObject = (obj: any, schemaName?: string): void => {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      obj.forEach((o) => processObject(o));
      return;
    }

    // Check if this is a TealValue schema with bytes property
    if (schemaName === "TealValue" && obj.properties && obj.properties.bytes) {
      obj.properties.bytes["x-algokit-bytes-base64"] = true;
      fixedCount++;
    }

    // Recursively process schemas
    if (obj.schemas && typeof obj.schemas === "object") {
      for (const [name, schemaDef] of Object.entries(obj.schemas)) {
        processObject(schemaDef, name);
      }
    } else {
      // Recursively process other nested objects
      for (const [key, value] of Object.entries(obj)) {
        if (value && typeof value === "object") {
          processObject(value, key);
        }
      }
    }
  };

  processObject(spec);
  return fixedCount;
}

/**
 * Fix bigint - Add x-algokit-bigint: true to properties that represent large integers
 */
function fixBigInt(spec: OpenAPISpec): number {
  let fixedCount = 0;

  // Properties that commonly represent large integers in Algorand/blockchain context
  const bigIntFields = [
    { fieldName: "fee" },
    { fieldName: "min-fee" },
    { fieldName: "round" },
    { fieldName: "round-number" },
    { fieldName: "min-round" },
    { fieldName: "max-round" },
    { fieldName: "last-round" },
    { fieldName: "confirmed-round" },
    { fieldName: "asset-id" },
    { fieldName: "created-application-index" },
    { fieldName: "created-asset-index" },
    { fieldName: "application-index" },
    { fieldName: "asset-index" },
    { fieldName: "current_round" },
    { fieldName: "online-money" },
    { fieldName: "total-money" },
    { fieldName: "amount" },
    { fieldName: "asset-closing-amount" },
    { fieldName: "closing-amount" },
    { fieldName: "close_rewards" },
    { fieldName: "id" },
    { fieldName: "index", excludedModels: ["LightBlockHeaderProof"] },
    { fieldName: "last-proposed" },
    { fieldName: "last-heartbeat" },
    { fieldName: "application-id" },
    { fieldName: "min-balance" },
    { fieldName: "amount-without-pending-rewards" },
    { fieldName: "pending-rewards" },
    { fieldName: "rewards" },
    { fieldName: "reward-base" },
    { fieldName: "vote-first-valid" },
    { fieldName: "vote-key-dilution" },
    { fieldName: "vote-last-valid" },
    { fieldName: "catchup-time" },
    { fieldName: "time-since-last-round" },
    { fieldName: "currency-greater-than" },
    { fieldName: "currency-less-than" },
    { fieldName: "rewards-calculation-round" },
    { fieldName: "rewards-level" },
    { fieldName: "rewards-rate" },
    { fieldName: "rewards-residue" },
    { fieldName: "next-protocol-switch-on" },
    { fieldName: "next-protocol-vote-before" },
    { fieldName: "upgrade-delay" },
    { fieldName: "app" },
    { fieldName: "asset" },
    { fieldName: "current-round" },
    { fieldName: "application-id" },
    { fieldName: "online-total-weight" },
    { fieldName: "close-amount" },
    { fieldName: "close-rewards" },
    { fieldName: "receiver-rewards" },
    { fieldName: "sender-rewards" },
  ];

  const processObject = (obj: any, objName?: string): void => {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      obj.forEach((o) => processObject(o));
      return;
    }

    // Iterate through all properties
    for (const [key, value] of Object.entries(obj)) {
      // Check if this is a properties object (schema properties)
      if (key === "properties" && value && typeof value === "object") {
        for (const [propName, propDef] of Object.entries(value as Record<string, any>)) {
          if (propDef && typeof propDef === "object" && propDef.type === "integer" && !propDef["x-algokit-bigint"]) {
            if (bigIntFields.findIndex((f) => f.fieldName === propName && (!objName || !f.excludedModels?.includes(objName))) > -1) {
              propDef["x-algokit-bigint"] = true;
              fixedCount++;
            }
          }
        }
      }

      // Check if this is a parameters array (query parameters)
      if (key === "parameters" && Array.isArray(value)) {
        for (const param of value) {
          if (param && typeof param === "object" && param.name && param.schema?.type === "integer" && !param.schema["x-algokit-bigint"]) {
            if (bigIntFields.findIndex((f) => f.fieldName === param.name && (!objName || !f.excludedModels?.includes(objName))) > -1) {
              param.schema["x-algokit-bigint"] = true;
              fixedCount++;
            }
          }
        }
      }

      // Recursively process nested objects
      if (value && typeof value === "object") {
        processObject(value, key);
      }
    }
  };

  processObject(spec);
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
function transformRequiredFields(spec: OpenAPISpec, requiredFieldTransforms: RequiredFieldTransform[]): number {
  let transformedCount = 0;

  if (!spec.components?.schemas || !requiredFieldTransforms?.length) {
    return transformedCount;
  }

  for (const config of requiredFieldTransforms) {
    const schema = spec.components.schemas[config.schemaName];

    if (!schema) {
      console.warn(`⚠️  Schema ${config.schemaName} not found, skipping field transform for ${config.fieldName}`);
      continue;
    }

    // Normalize fieldName to an array for consistent processing
    const fieldNames = Array.isArray(config.fieldName) ? config.fieldName : [config.fieldName];

    // Initialize required array if it doesn't exist and we're making a field required
    if (config.makeRequired && !schema.required) {
      schema.required = [];
    }

    for (const fieldName of fieldNames) {
      if (config.makeRequired) {
        // Make field required: add to required array if not already present
        if (!schema.required.includes(fieldName)) {
          schema.required.push(fieldName);
          transformedCount++;
          console.log(`ℹ️  Made ${fieldName} required in ${config.schemaName}`);
        }
      } else {
        // Make field optional: remove from required array
        if (schema.required && Array.isArray(schema.required)) {
          const originalLength = schema.required.length;
          schema.required = schema.required.filter((field: string) => field !== fieldName);

          // If the required array is now empty, remove it entirely
          if (schema.required.length === 0) {
            delete schema.required;
          }

          const removedCount = originalLength - (schema.required?.length || 0);
          if (removedCount > 0) {
            transformedCount += removedCount;
            console.log(`ℹ️  Made ${fieldName} optional in ${config.schemaName}`);
          }
        }
      }
    }
  }

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
function linkSchemaToProperties(spec: OpenAPISpec, propertyName: string, schemaName: string): number {
  let updatedCount = 0;

  const updatePropertyReferences = (obj: any): void => {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      for (const item of obj) updatePropertyReferences(item);
      return;
    }

    // Check if this is a properties object containing our target property
    if (obj.properties && obj.properties[propertyName]) {
      const property = obj.properties[propertyName];

      // Check if it's currently using an empty object schema or inline schema
      if (property.type === "object" && (!property.properties || Object.keys(property.properties).length === 0)) {
        // Replace with schema reference
        obj.properties[propertyName] = {
          $ref: `#/components/schemas/${schemaName}`,
        };
        updatedCount++;
        console.log(`ℹ️  Updated ${propertyName} property to reference ${schemaName} schema`);
      }
    }

    // Recursively check all object values
    for (const value of Object.values(obj)) {
      updatePropertyReferences(value);
    }
  };

  updatePropertyReferences(spec);
  return updatedCount;
}

/**
 * Rename component schemas and update all $ref usages according to configuration.
 * Adds x-algokit-original-name metadata for traceability.
 */
function renameSchemas(spec: OpenAPISpec, renames: SchemaRename[]): number {
  let renamed = 0;

  const components = spec.components;
  if (!components || !components.schemas || !renames?.length) {
    return renamed;
  }

  const schemas = components.schemas as Record<string, any>;
  const oldToNewName: Record<string, string> = {};
  const newSchemas: Record<string, any> = {};

  // Build rename map from configuration
  const renameMap = new Map(renames.map((r) => [r.from, r]));

  // 1) Build rename map and new schemas object
  for (const [name, schema] of Object.entries(schemas)) {
    const renameConfig = renameMap.get(name);

    if (!renameConfig) {
      // No rename configured, keep as-is
      newSchemas[name] = schema;
      continue;
    }

    const target = renameConfig.to;
    oldToNewName[name] = target;
    const schemaCopy = { ...(schema as any) };
    schemaCopy["x-algokit-original-name"] = name;

    // Update description
    if (schemaCopy.description && typeof schemaCopy.description === "string") {
      schemaCopy.description = schemaCopy.description.replace(new RegExp(name, "g"), target).replace(/\nfriendly:.+$/, "");
    }

    newSchemas[target] = schemaCopy;
    renamed++;
  }

  // Apply renamed schemas
  components.schemas = newSchemas as any;

  if (renamed === 0) {
    return renamed;
  }

  // 2) Update all $ref occurrences pointing to old schema names
  const updateRefs = (obj: any): void => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) updateRefs(item);
      return;
    }

    if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/components/schemas/")) {
      const refName = obj.$ref.substring("#/components/schemas/".length);
      const newName = oldToNewName[refName];
      if (newName) {
        obj.$ref = `#/components/schemas/${newName}`;
      }
    }

    for (const value of Object.values(obj)) updateRefs(value);
  };

  updateRefs(spec);

  return renamed;
}

/**
 * Rename fields within schemas (actual field name changes, not just metadata)
 */
function renameSchemaFields(spec: OpenAPISpec, fieldRenames: SchemaFieldRename[]): number {
  let renamedCount = 0;

  if (!spec.components?.schemas || !fieldRenames || fieldRenames.length === 0) {
    return renamedCount;
  }

  const schemas = spec.components.schemas as Record<string, any>;

  for (const config of fieldRenames) {
    const schema = schemas[config.schemaName];

    if (!schema || typeof schema !== "object" || !schema.properties) {
      console.warn(`⚠️  Schema '${config.schemaName}' not found or has no properties, skipping field renames`);
      continue;
    }

    for (const rename of config.fieldRenames) {
      if (!schema.properties.hasOwnProperty(rename.from)) {
        console.warn(`⚠️  Field '${rename.from}' not found in schema '${config.schemaName}', skipping rename`);
        continue;
      }

      // Rename the field
      schema.properties[rename.to] = schema.properties[rename.from];
      delete schema.properties[rename.from];

      // Update required array if it exists
      if (schema.required && Array.isArray(schema.required)) {
        const index = schema.required.indexOf(rename.from);
        if (index !== -1) {
          schema.required[index] = rename.to;
        }
      }

      renamedCount++;
      console.log(`ℹ️  Renamed field '${rename.from}' to '${rename.to}' in schema '${config.schemaName}'`);
    }
  }

  return renamedCount;
}

/**
 * Remove specified fields from all schemas in the spec
 */
function removeSchemaFields(spec: OpenAPISpec, fieldsToRemove: string[]): number {
  let removedCount = 0;

  if (!spec.components?.schemas || !fieldsToRemove || fieldsToRemove.length === 0) {
    return removedCount;
  }

  const schemas = spec.components.schemas as Record<string, any>;

  for (const [schemaName, schema] of Object.entries(schemas)) {
    if (!schema || typeof schema !== "object" || !schema.properties) {
      continue;
    }

    for (const fieldName of fieldsToRemove) {
      if (schema.properties.hasOwnProperty(fieldName)) {
        delete schema.properties[fieldName];
        removedCount++;
        console.log(`ℹ️  Removed field '${fieldName}' from schema '${schemaName}'`);
      }
    }
  }

  return removedCount;
}

/**
 * Make all properties required in all schemas
 */
function makeAllFieldsRequired(spec: OpenAPISpec): number {
  let modifiedCount = 0;

  if (!spec.components?.schemas) {
    return modifiedCount;
  }

  const schemas = spec.components.schemas as Record<string, any>;

  for (const [schemaName, schema] of Object.entries(schemas)) {
    if (!schema || typeof schema !== "object" || !schema.properties) {
      continue;
    }

    const propertyNames = Object.keys(schema.properties);

    if (propertyNames.length === 0) {
      continue;
    }

    // Initialize required array if it doesn't exist
    if (!schema.required) {
      schema.required = [];
    }

    // Add all properties to required array if not already present
    let addedCount = 0;
    for (const propertyName of propertyNames) {
      if (!schema.required.includes(propertyName)) {
        schema.required.push(propertyName);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      modifiedCount += addedCount;
      console.log(`ℹ️  Made ${addedCount} field(s) required in schema '${schemaName}'`);
    }
  }

  return modifiedCount;
}

/**
 * Transform endpoint tags by adding or removing tags from specific endpoints
 */
function transformEndpointTags(spec: OpenAPISpec, transforms: EndpointTagTransform[]): number {
  let modifiedCount = 0;

  if (!spec.paths || !transforms?.length) {
    return modifiedCount;
  }

  const allMethods = ["get", "post", "put", "delete", "patch", "head", "options", "trace"];

  for (const transform of transforms) {
    const pathObj = spec.paths[transform.path];
    if (!pathObj) {
      console.warn(`⚠️  Path ${transform.path} not found in spec for tag transform`);
      continue;
    }

    const methods = transform.methods || allMethods;

    for (const method of methods) {
      const operation = pathObj[method];
      if (!operation) {
        continue;
      }

      // Initialize tags array if it doesn't exist
      if (!operation.tags) {
        operation.tags = [];
      }

      // Remove tags if specified
      if (transform.removeTags && transform.removeTags.length > 0) {
        const originalLength = operation.tags.length;
        operation.tags = operation.tags.filter((tag: string) => !transform.removeTags!.includes(tag));
        const removedCount = originalLength - operation.tags.length;
        if (removedCount > 0) {
          modifiedCount += removedCount;
          console.log(`ℹ️  Removed ${removedCount} tag(s) from ${transform.path} (${method})`);
        }
      }

      // Add tags if specified
      if (transform.addTags && transform.addTags.length > 0) {
        for (const tag of transform.addTags) {
          if (!operation.tags.includes(tag)) {
            operation.tags.push(tag);
            modifiedCount++;
            console.log(`ℹ️  Added tag '${tag}' to ${transform.path} (${method})`);
          }
        }
      }
    }
  }

  return modifiedCount;
}

/**
 * Remove schemas that have no properties and update all references to them
 */
function removeEmptySchemas(spec: OpenAPISpec): { removedSchemas: number; updatedReferences: number } {
  let removedSchemas = 0;
  let updatedReferences = 0;

  if (!spec.components?.schemas) {
    return { removedSchemas, updatedReferences };
  }

  const schemas = spec.components.schemas as Record<string, any>;
  const emptySchemasToRemove: string[] = [];

  // Find schemas with empty properties
  for (const [schemaName, schema] of Object.entries(schemas)) {
    if (
      schema &&
      typeof schema === "object" &&
      schema.properties &&
      typeof schema.properties === "object" &&
      Object.keys(schema.properties).length === 0
    ) {
      emptySchemasToRemove.push(schemaName);
      console.log(`ℹ️  Found empty schema: ${schemaName}`);
    }
  }

  if (emptySchemasToRemove.length === 0) {
    return { removedSchemas, updatedReferences };
  }

  // Function to recursively find and replace schema references
  const replaceSchemaReferences = (obj: any, parent: any = null, parentKey: string = ""): void => {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      obj.forEach((item, index) => replaceSchemaReferences(item, obj, index.toString()));
      return;
    }

    // Check if this is a "content" object that contains a reference to an empty schema
    if (parentKey === "content" && obj && typeof obj === "object") {
      // Check each media type in the content object
      for (const [mediaType, mediaTypeObj] of Object.entries(obj)) {
        if (
          mediaTypeObj &&
          typeof mediaTypeObj === "object" &&
          (mediaTypeObj as any).schema &&
          typeof (mediaTypeObj as any).schema === "object"
        ) {
          const schema = (mediaTypeObj as any).schema;
          if (schema.$ref && typeof schema.$ref === "string") {
            const refMatch = schema.$ref.match(/^#\/components\/schemas\/(.+)$/);
            if (refMatch && emptySchemasToRemove.includes(refMatch[1])) {
              // This references an empty schema, replace the entire content object with {}
              if (parent && parent[parentKey]) {
                parent[parentKey] = {};
                updatedReferences++;
                console.log(`ℹ️  Replaced content object referencing empty schema '${refMatch[1]}' with {}`);
                return; // Don't process further since we replaced the whole content object
              }
            }
          }
        }
      }
    }

    // Recursively process nested objects
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === "object") {
        replaceSchemaReferences(value, obj, key);
      }
    }
  };

  // Process all paths to find and replace references
  if (spec.paths) {
    replaceSchemaReferences(spec.paths);
  }

  // Process all components to find and replace references (except schemas themselves)
  if (spec.components) {
    const { schemas: _, ...otherComponents } = spec.components;
    replaceSchemaReferences(otherComponents);
  }

  // Remove the empty schemas
  for (const schemaName of emptySchemasToRemove) {
    delete schemas[schemaName];
    removedSchemas++;
    console.log(`ℹ️  Removed empty schema: ${schemaName}`);
  }

  return { removedSchemas, updatedReferences };
}

// ===== MAIN PROCESSOR =====

class OpenAPIProcessor {
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
    const outputDir = dirname(this.config.outputPath);
    mkdirSync(outputDir, { recursive: true });

    const indent = this.config.indent || 2;
    const content = JSON.stringify(spec, null, indent);

    writeFileSync(this.config.outputPath, content, "utf8");
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
        const { removedSchemas, updatedReferences } = removeEmptySchemas(spec);
        if (removedSchemas > 0) {
          console.log(`ℹ️  Removed ${removedSchemas} empty schemas and updated ${updatedReferences} references`);
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
        let linkedPropertiesCount = 0;
        for (const customSchema of this.config.customSchemas) {
          customSchemaCount += createCustomSchema(spec, customSchema.name, customSchema.schema);

          // Link properties to this schema if specified
          if (customSchema.linkToProperties && customSchema.linkToProperties.length > 0) {
            for (const propertyName of customSchema.linkToProperties) {
              linkedPropertiesCount += linkSchemaToProperties(spec, propertyName, customSchema.name);
            }
          }
        }
        console.log(`ℹ️  Created ${customSchemaCount} custom schemas`);
        if (linkedPropertiesCount > 0) {
          console.log(`ℹ️  Linked ${linkedPropertiesCount} properties to custom schemas`);
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

// ===== MAIN EXECUTION =====

/**
 * Fetch the latest stable tag from GitHub API for go-algorand
 */
async function getLatestStableTag(): Promise<string> {
  console.log("ℹ️  Fetching latest stable tag from GitHub...");

  try {
    const response = await fetch("https://api.github.com/repos/algorand/go-algorand/tags");
    if (!response.ok) {
      throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
    }

    const tags = await response.json();

    // Find the latest tag that contains '-stable'
    const stableTag = tags.find((tag: any) => tag.name.includes("-stable"));

    if (!stableTag) {
      throw new Error("No stable tag found in the repository");
    }

    console.log(`✅ Found latest stable tag: ${stableTag.name}`);
    return stableTag.name;
  } catch (error) {
    console.error("❌ Failed to fetch stable tag, falling back to master branch");
    console.error(error instanceof Error ? error.message : error);
    return "master";
  }
}

/**
 * Fetch the latest release tag from GitHub API for indexer
 */
async function getLatestIndexerTag(): Promise<string> {
  console.log("ℹ️  Fetching latest indexer release tag from GitHub...");

  try {
    const response = await fetch("https://api.github.com/repos/algorand/indexer/releases/latest");
    if (!response.ok) {
      throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
    }

    const release = await response.json();

    console.log(`✅ Found latest indexer release tag: ${release.tag_name}`);
    return release.tag_name;
  } catch (error) {
    console.error("❌ Failed to fetch indexer release tag, falling back to master branch");
    console.error(error instanceof Error ? error.message : error);
    return "master";
  }
}

/**
 * Process specifications for algod, indexer, and kmd
 */
async function processAlgorandSpecs() {
  await Promise.all([processAlgodSpec(), processIndexerSpec(), processKmdSpec()]);
}

async function processAlgodSpec() {
  console.log("\n🔄 Processing Algod specification...");

  const stableTag = await getLatestStableTag();

  const config: ProcessingConfig = {
    sourceUrl: `https://raw.githubusercontent.com/algorand/go-algorand/${stableTag}/daemon/algod/api/algod.oas2.json`,
    outputPath: join(process.cwd(), "specs", "algod.oas3.json"),
    requiredFieldTransforms: [
      {
        schemaName: "Genesis",
        fieldName: "timestamp",
        makeRequired: false,
      },
    ],
    fieldTransforms: [
      {
        fieldName: "action",
        removeItems: ["format"],
      },
      {
        fieldName: "num-uint",
        removeItems: ["format"],
        addItems: {
          minimum: 0,
          maximum: 64,
        },
      },
      {
        fieldName: "num-byte-slice",
        removeItems: ["format"],
        addItems: {
          minimum: 0,
          maximum: 64,
        },
      },
      {
        fieldName: "extra-program-pages",
        removeItems: ["format"],
        addItems: {
          minimum: 0,
          maximum: 3,
        },
      },
      {
        fieldName: "upgrade-votes-required",
        removeItems: ["x-go-type"],
      },
      {
        fieldName: "upgrade-votes",
        removeItems: ["x-go-type"],
      },
      {
        fieldName: "upgrade-yes-votes",
        removeItems: ["x-go-type"],
      },
      {
        fieldName: "upgrade-no-votes",
        removeItems: ["x-go-type"],
      },
      {
        fieldName: "upgrade-vote-rounds",
        removeItems: ["x-go-type"],
      },
      {
        fieldName: "type",
        removeItems: ["x-go-type"],
      },
      {
        fieldName: "decimals",
        removeItems: ["format"],
      },
      {
        fieldName: "total-apps-opted-in",
        removeItems: ["format"],
      },
      {
        fieldName: "total-assets-opted-in",
        removeItems: ["format"],
      },
      {
        fieldName: "total-created-apps",
        removeItems: ["format"],
      },
      {
        fieldName: "total-created-assets",
        removeItems: ["format"],
      },
      {
        fieldName: "apps-total-extra-pages",
        removeItems: ["format"],
      },
      {
        fieldName: "total-boxes",
        removeItems: ["format"],
      },
      {
        fieldName: "total-box-bytes",
        removeItems: ["format"],
      },
      {
        fieldName: "key",
        schemaName: "TealKeyValue",
        addItems: {
          pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
          format: "byte",
        },
      },
      {
        fieldName: "key",
        schemaName: "EvalDeltaKeyValue",
        addItems: {
          pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
          format: "byte",
        },
      },
      {
        fieldName: "bytes",
        schemaName: "AvmValue",
        addItems: {
          format: "byte",
        },
      },
      {
        fieldName: "bytes",
        schemaName: "EvalDelta",
        addItems: {
          pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
          format: "byte",
        },
      },
      {
        fieldName: "address",
        addItems: {
          "x-algorand-format": "Address",
        },
      },
      {
        fieldName: "txid",
        addItems: {
          "x-algokit-field-rename": "txId",
        },
      },
      {
        fieldName: "tx-id",
        addItems: {
          "x-algokit-field-rename": "txId",
        },
      },
    ],
    vendorExtensionTransforms: [
      {
        sourceProperty: "x-algorand-format",
        sourceValue: "uint64",
        targetProperty: "x-algokit-bigint",
        targetValue: true,
        removeSource: true,
      },
      {
        sourceProperty: "format",
        sourceValue: "uint64",
        targetProperty: "x-algokit-bigint",
        targetValue: true,
        removeSource: false,
      },
      {
        sourceProperty: "x-algorand-format",
        sourceValue: "SignedTransaction",
        targetProperty: "x-algokit-signed-txn",
        targetValue: true,
        removeSource: true,
      },
      {
        sourceProperty: "x-go-type",
        sourceValue: "basics.AppIndex",
        targetProperty: "x-algokit-bigint",
        targetValue: true,
        removeSource: false,
      },
      {
        sourceProperty: "x-go-type",
        sourceValue: "basics.Round",
        targetProperty: "x-algokit-bigint",
        targetValue: true,
        removeSource: false,
      },
      {
        sourceProperty: "x-go-type",
        sourceValue: "basics.AssetIndex",
        targetProperty: "x-algokit-bigint",
        targetValue: true,
        removeSource: false,
      },
      {
        sourceProperty: "operationId",
        sourceValue: "GetBlockTxids",
        targetProperty: "operationId",
        targetValue: "GetBlockTxIds",
        removeSource: false,
      },
      {
        sourceProperty: "operationId",
        sourceValue: "SimulateTransaction",
        targetProperty: "operationId",
        targetValue: "SimulateTransactions",
        removeSource: false,
      },
      {
        sourceProperty: "operationId",
        sourceValue: "WaitForBlock",
        targetProperty: "operationId",
        targetValue: "StatusAfterBlock",
        removeSource: false,
      },
      {
        sourceProperty: "x-go-type",
        sourceValue: "basics.Address",
        targetProperty: "x-algorand-format",
        targetValue: "Address",
        removeSource: false,
      },
    ],
    msgpackOnlyEndpoints: [
      // Align with Go and JS SDKs that hardcode these to msgpack
      { path: "/v2/blocks/{round}", methods: ["get"] },
      { path: "/v2/transactions/pending", methods: ["get"] },
      { path: "/v2/transactions/pending/{txid}", methods: ["get"] },
      { path: "/v2/accounts/{address}/transactions/pending", methods: ["get"] },
      { path: "/v2/deltas/{round}", methods: ["get"] },
      { path: "/v2/deltas/txn/group/{id}", methods: ["get"] },
      { path: "/v2/deltas/{round}/txn/group", methods: ["get"] },
      { path: "/v2/transactions/simulate", methods: ["post"] },
    ],
    jsonOnlyEndpoints: [
      { path: "/v2/accounts/{address}", methods: ["get"] },
      { path: "/v2/accounts/{address}/assets/{asset-id}", methods: ["get"] },
    ],
    customSchemas: [
      {
        name: "SourceMap",
        schema: {
          type: "object",
          required: ["version", "sources", "names", "mappings"],
          properties: {
            version: {
              type: "integer",
            },
            sources: {
              description: 'A list of original sources used by the "mappings" entry.',
              type: "array",
              items: {
                type: "string",
              },
            },
            names: {
              description: 'A list of symbol names used by the "mappings" entry.',
              type: "array",
              items: {
                type: "string",
              },
            },
            mappings: {
              description: "A string with the encoded mapping data.",
              type: "string",
            },
          },
          description: "Source map for the program",
        },
        linkToProperties: ["sourcemap"],
      },
    ],
    endpointTagTransforms: [
      // Mark dryrun endpoint as legacy (superseded by simulate)
      { path: "/v2/teal/dryrun", methods: ["post"], addTags: ["legacy"] },
    ],
  };

  await processAlgorandSpec(config);
}

async function processKmdSpec() {
  console.log("\n🔄 Processing KMD specification...");

  const stableTag = await getLatestStableTag();

  const config: ProcessingConfig = {
    sourceUrl: `https://raw.githubusercontent.com/algorand/go-algorand/${stableTag}/daemon/kmd/api/swagger.json`,
    outputPath: join(process.cwd(), "specs", "kmd.oas3.json"),
    schemaRenames: [
      { from: "APIV1DELETEKeyResponse", to: "DeleteKeyResponse" },
      { from: "APIV1DELETEMultisigResponse", to: "DeleteMultisigResponse" },
      { from: "APIV1GETWalletsResponse", to: "ListWalletsResponse" },
      { from: "APIV1POSTKeyExportResponse", to: "ExportKeyResponse" },
      { from: "APIV1POSTKeyImportResponse", to: "ImportKeyResponse" },
      { from: "APIV1POSTKeyListResponse", to: "ListKeysResponse" },
      { from: "APIV1POSTKeyResponse", to: "GenerateKeyResponse" },
      { from: "APIV1POSTMasterKeyExportResponse", to: "ExportMasterKeyResponse" },
      { from: "APIV1POSTMultisigExportResponse", to: "ExportMultisigResponse" },
      { from: "APIV1POSTMultisigImportResponse", to: "ImportMultisigResponse" },
      { from: "APIV1POSTMultisigListResponse", to: "ListMultisigResponse" },
      { from: "APIV1POSTMultisigProgramSignResponse", to: "SignProgramMultisigResponse" },
      { from: "APIV1POSTMultisigTransactionSignResponse", to: "SignMultisigResponse" },
      { from: "APIV1POSTProgramSignResponse", to: "SignProgramResponse" },
      { from: "APIV1POSTTransactionSignResponse", to: "SignTransactionResponse" },
      { from: "APIV1POSTWalletInfoResponse", to: "WalletInfoResponse" },
      { from: "APIV1POSTWalletInitResponse", to: "InitWalletHandleTokenResponse" },
      { from: "APIV1POSTWalletReleaseResponse", to: "ReleaseWalletHandleTokenResponse" },
      { from: "APIV1POSTWalletRenameResponse", to: "RenameWalletResponse" },
      { from: "APIV1POSTWalletRenewResponse", to: "RenewWalletHandleTokenResponse" },
      { from: "APIV1POSTWalletResponse", to: "CreateWalletResponse" },
      { from: "APIV1Wallet", to: "Wallet" },
      { from: "APIV1WalletHandle", to: "WalletHandle" },
      // These are renamed, so we can use the original name for a customised type
      { from: "SignMultisigRequest", to: "SignMultisigTxnRequest" },
      { from: "SignTransactionRequest", to: "SignTxnRequest" },
    ],
    schemaFieldRenames: [
      {
        schemaName: "MultisigSig",
        fieldRenames: [
          { from: "Subsigs", to: "subsig" },
          { from: "Threshold", to: "thr" },
          { from: "Version", to: "v" },
        ],
      },
      {
        schemaName: "MultisigSubsig",
        fieldRenames: [
          { from: "Key", to: "pk" },
          { from: "Sig", to: "s" },
        ],
      },
    ],
    removeSchemaFields: ["error", "message", "display_mnemonic"],
    makeAllFieldsRequired: true,
    requiredFieldTransforms: [
      {
        schemaName: "CreateWalletRequest",
        fieldName: ["master_derivation_key", "wallet_driver_name"],
        makeRequired: false,
      },
      {
        schemaName: "SignTxnRequest",
        fieldName: ["wallet_password", "public_key"],
        makeRequired: false,
      },
      {
        schemaName: "SignProgramMultisigRequest",
        fieldName: ["wallet_password", "partial_multisig", "use_legacy_msig"],
        makeRequired: false,
      },
      {
        schemaName: "SignMultisigTxnRequest",
        fieldName: ["wallet_password", "partial_multisig", "signer"],
        makeRequired: false,
      },
      {
        schemaName: "DeleteKeyRequest",
        fieldName: ["wallet_password"],
        makeRequired: false,
      },
      {
        schemaName: "DeleteMultisigRequest",
        fieldName: ["wallet_password"],
        makeRequired: false,
      },
      {
        schemaName: "ExportKeyRequest",
        fieldName: ["wallet_password"],
        makeRequired: false,
      },
      {
        schemaName: "ExportMasterKeyRequest",
        fieldName: ["wallet_password"],
        makeRequired: false,
      },
      {
        schemaName: "SignProgramRequest",
        fieldName: ["wallet_password"],
        makeRequired: false,
      },
      {
        schemaName: "MultisigSubsig",
        fieldName: ["s"], // TODO: NC - Confirm if this is correct
        makeRequired: false,
      },
    ],
    fieldTransforms: [
      {
        fieldName: "private_key",
        removeItems: ["$ref"],
        addItems: {
          type: "string",
          "x-algokit-bytes-base64": true,
        },
      },
      {
        schemaName: "MultisigSig",
        fieldName: "subsig",
        addItems: {
          "x-algokit-field-rename": "subsignatures",
        },
      },
      {
        schemaName: "MultisigSig",
        fieldName: "thr",
        addItems: {
          "x-algokit-field-rename": "threshold",
        },
      },
      {
        schemaName: "MultisigSig",
        fieldName: "v",
        addItems: {
          "x-algokit-field-rename": "version",
        },
      },
      {
        schemaName: "MultisigSubsig",
        fieldName: "pk",
        addItems: {
          "x-algokit-field-rename": "publicKey",
        },
      },
      {
        schemaName: "MultisigSubsig",
        fieldName: "s",
        addItems: {
          "x-algokit-field-rename": "signature",
        },
      },
      {
        schemaName: "SignProgramRequest",
        fieldName: "data",
        addItems: {
          "x-algokit-field-rename": "program",
        },
      },
      {
        schemaName: "SignProgramMultisigRequest",
        fieldName: "data",
        addItems: {
          "x-algokit-field-rename": "program",
        },
      },
      {
        fieldName: "addresses.items",
        addItems: {
          "x-algorand-format": "Address",
        },
      },
      {
        fieldName: "pks",
        addItems: {
          "x-algokit-field-rename": "publicKeys",
        },
      },
      {
        fieldName: "wallet_driver_name",
        addItems: {
          default: "sqlite",
        },
      },
    ],
    vendorExtensionTransforms: [
      {
        sourceProperty: "format",
        sourceValue: "uint64",
        targetProperty: "x-algokit-bigint",
        targetValue: true,
        removeSource: false,
      },
      {
        sourceProperty: "operationId",
        sourceValue: "ListMultisg",
        targetProperty: "operationId",
        targetValue: "ListMultisig",
        removeSource: false,
      },
      {
        sourceProperty: "operationId",
        sourceValue: "InitWalletHandleToken",
        targetProperty: "operationId",
        targetValue: "InitWalletHandle",
        removeSource: false,
      },
      {
        sourceProperty: "x-go-name",
        sourceValue: "Address",
        targetProperty: "x-algorand-format",
        targetValue: "Address",
        removeSource: false,
      },
    ],
  };

  await processAlgorandSpec(config);
}

async function processIndexerSpec() {
  console.log("\n🔄 Processing Indexer specification...");

  const indexerTag = await getLatestIndexerTag();

  const config: ProcessingConfig = {
    sourceUrl: `https://raw.githubusercontent.com/algorand/indexer/${indexerTag}/api/indexer.oas2.json`,
    outputPath: join(process.cwd(), "specs", "indexer.oas3.json"),
    requiredFieldTransforms: [
      {
        schemaName: "ApplicationParams",
        fieldName: "approval-program",
        makeRequired: false,
      },
      {
        schemaName: "ApplicationParams",
        fieldName: "clear-state-program",
        makeRequired: false,
      },
    ],
    fieldTransforms: [
      {
        fieldName: "num-uint",
        removeItems: ["x-algorand-format"],
        addItems: {
          minimum: 0,
          maximum: 64,
        },
      },
      {
        fieldName: "num-byte-slice",
        removeItems: ["x-algorand-format"],
        addItems: {
          minimum: 0,
          maximum: 64,
        },
      },
      {
        fieldName: "extra-program-pages",
        addItems: {
          minimum: 0,
          maximum: 3,
        },
      },
      {
        fieldName: "foreign-apps.items",
        addItems: {
          "x-algokit-bigint": true,
        },
      },
      {
        fieldName: "foreign-assets.items",
        addItems: {
          "x-algokit-bigint": true,
        },
      },
      {
        fieldName: "account-id.schema",
        addItems: {
          "x-algorand-format": "Address",
        },
      },
      {
        fieldName: "account-id",
        addItems: {
          "x-algokit-field-rename": "account",
        },
      },
      {
        fieldName: "txid",
        addItems: {
          "x-algokit-field-rename": "txId",
        },
      },
    ],
    vendorExtensionTransforms: [
      {
        sourceProperty: "x-algorand-format",
        sourceValue: "uint64",
        targetProperty: "x-algokit-bigint",
        targetValue: true,
        removeSource: true,
      },
      {
        sourceProperty: "format",
        sourceValue: "uint64",
        targetProperty: "x-algokit-bigint",
        targetValue: true,
        removeSource: false,
      },
      {
        sourceProperty: "x-algorand-format",
        sourceValue: "SignedTransaction",
        targetProperty: "x-algokit-signed-txn",
        targetValue: true,
        removeSource: true,
      },
      {
        sourceProperty: "x-algorand-foramt",
        sourceValue: "uint64",
        targetProperty: "x-algorand-format",
        targetValue: "uint64",
        removeSource: true,
      },
      {
        sourceProperty: "operationId",
        sourceValue: "lookupTransaction",
        targetProperty: "operationId",
        targetValue: "lookupTransactionByID",
        removeSource: false,
      },
    ],
  };

  await processAlgorandSpec(config);
}

async function processAlgorandSpec(config: ProcessingConfig) {
  const processor = new OpenAPIProcessor(config);
  await processor.process();
}

// Example usage
async function main() {
  try {
    const args = process.argv.slice(2);

    // Support for individual spec processing or all
    if (args.includes("--algod-only")) {
      await processAlgodSpec();
    } else if (args.includes("--indexer-only")) {
      await processIndexerSpec();
    } else if (args.includes("--kmd-only")) {
      await processKmdSpec();
    } else {
      // Process all by default
      await processAlgorandSpecs();
    }
  } catch (error) {
    console.error("❌ Fatal error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run if this is the main module
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  void main();
}
