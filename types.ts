// ===== TYPES =====

export interface OpenAPISpec {
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

export interface VendorExtensionTransform {
  sourceProperty: string; // e.g., "x-algorand-format" or "format"
  sourceValue: string; // e.g., "uint64"
  targetProperty: string; // e.g., "x-algokit-bigint"
  targetValue: boolean | string; // value to set
  removeSource?: boolean; // whether to remove the source property (default false)
}

export interface RequiredFieldTransform {
  schemaName: string; // e.g., "ApplicationParams" - The OpenAPI schema name
  fieldName: string | string[]; // e.g., "approval-program" or ["approval-program", "clear-state-program"] - The field name(s) to transform
  makeRequired: boolean; // true = add to required array, false = remove from required array
}

export interface FieldTransform {
  fieldName: string; // e.g., "action"
  schemaName?: string; // Optional: specific schema name to target, e.g., "TealKeyValue"
  removeItems?: string[]; // properties to remove from the target property, e.g., ["format"]
  addItems?: Record<string, any>; // properties to add to the target property, e.g., {"x-custom": true}
}

export interface FilterEndpoint {
  path: string; // Exact path to match (e.g., "/v2/blocks/{round}")
  methods?: string[]; // HTTP methods to apply to (default: ["get"])
}

export interface FieldRename {
  from: string; // Original field name
  to: string; // New field name
  schemaName?: string; // Optional: specific schema name to target
}

export interface CustomSchema {
  name: string; // Schema name
  schema: Record<string, unknown>; // Schema definition object
  linkToProperties?: string[]; // Optional: property names to update with this schema reference
  vendorExtensions?: Record<string, any>; // Optional: vendor extensions to add to the schema
}

export interface SchemaRename {
  from: string; // Original schema name
  to: string; // New schema name
}

export interface SchemaFieldRename {
  schemaName: string; // Schema name to target
  fieldRenames: { from: string; to: string }[]; // Field renames to apply
}

export interface EndpointTagTransform {
  path: string; // Exact path to match (e.g., "/v2/teal/dryrun")
  methods?: string[]; // HTTP methods to apply to (default: all methods on the path)
  addTags?: string[]; // Tags to add to the endpoint
  removeTags?: string[]; // Tags to remove from the endpoint
}

export interface ProcessingConfig {
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
  // Schema-level vendor extensions to add (e.g., x-algokit-box-reference on BoxReference schema)
  schemaVendorExtensions?: SchemaVendorExtension[];
}

export interface OAS2Spec {
  swagger?: string;
  definitions?: Record<string, any>;
  responses?: Record<string, any>;
  parameters?: Record<string, any>;
  [key: string]: any;
}

// ===== INTERFACES FOR CONFIG EXTRACTION =====

export interface BigIntField {
  fieldName: string;
  excludedModels?: string[];
}

export interface SchemaVendorExtension {
  schemaName: string;
  extension: string;
  value: unknown;
}

export interface SpecConfig extends Omit<ProcessingConfig, "sourceUrl" | "outputPath" | "converterEndpoint" | "indent" | "customSchemas"> {
  customSchemas?: Omit<CustomSchema, "schema">[];
}
