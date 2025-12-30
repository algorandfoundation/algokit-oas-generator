import type {
  VendorExtensionTransform,
  RequiredFieldTransform,
  FieldTransform,
  FilterEndpoint,
  FieldRename,
  CustomSchema,
  SchemaRename,
  SchemaFieldRename,
  EndpointTagTransform,
  BigIntField,
  ProcessingConfig,
  SchemaVendorExtension,
  OperationIdTransform,
} from "./types.js";

// ===== MISSING DESCRIPTIONS =====

export const MISSING_DESCRIPTIONS = new Map([
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

// ===== FIELD RENAMES =====

export const FIELD_RENAMES: FieldRename[] = [
  { from: "application-index", to: "app_id" },
  { from: "app-index", to: "app_id" },
  { from: "created-application-index", to: "created_app_id" },
  { from: "asset-index", to: "asset_id" },
  { from: "created-asset-index", to: "created_asset_id" },
  { from: "index", to: "id", schemaName: "Asset" },
  { from: "blockTxids", to: "block_tx_ids" },
];

// ===== BIGINT FIELDS =====

export const BIGINT_FIELDS: BigIntField[] = [
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
  { fieldName: "first-valid" },
  { fieldName: "last-valid" },
];

// ===== SHARED VENDOR EXTENSION TRANSFORMS =====

export const UINT64_TRANSFORMS: VendorExtensionTransform[] = [
  { sourceProperty: "x-algorand-format", sourceValue: "uint64", targetProperty: "x-algokit-bigint", targetValue: true, removeSource: true },
  { sourceProperty: "format", sourceValue: "uint64", targetProperty: "x-algokit-bigint", targetValue: true, removeSource: false },
];

export const SIGNED_TXN_TRANSFORM: VendorExtensionTransform = {
  sourceProperty: "x-algorand-format",
  sourceValue: "SignedTransaction",
  targetProperty: "x-algokit-signed-txn",
  targetValue: true,
  removeSource: true,
};

export const BOX_REFERENCE_TRANSFORM: VendorExtensionTransform = {
  sourceProperty: "title",
  sourceValue: "BoxReference",
  targetProperty: "x-algokit-box-reference",
  targetValue: true,
  removeSource: false,
};

// ===== FIXED-LENGTH BYTE ARRAY FIELDS =====
// Fields that represent fixed-length byte arrays (similar to js-algorand-sdk's FixedLengthByteArraySchema)
// These are byte fields that should have a specific length constraint for validation

export interface FixedLengthByteField {
  fieldName: string;
  byteLength: number;
  schemaName?: string; // Optional: specific schema name to target
}

export const FIXED_LENGTH_BYTE_FIELDS: FixedLengthByteField[] = [
  // 32-byte fields (public keys, hashes)
  { fieldName: "genesis-hash", byteLength: 32 },
  { fieldName: "selection-participation-key", byteLength: 32 },
  { fieldName: "vote-participation-key", byteLength: 32 },
  { fieldName: "previous-block-hash", byteLength: 32 },
  { fieldName: "seed", byteLength: 32 },
  { fieldName: "transactions-root", byteLength: 32 },
  { fieldName: "transactions-root-sha256", byteLength: 32 },
  { fieldName: "metadata-hash", byteLength: 32 },
  // Transaction fields (32-byte)
  { fieldName: "lease", byteLength: 32 },
  { fieldName: "group", byteLength: 32 },
  // Multisig subsignature public key (32-byte)
  { fieldName: "public-key", schemaName: "TransactionSignatureMultisigSubsignature", byteLength: 32 },
  // Heartbeat fields (32-byte) - matching algokit-utils-ts
  { fieldName: "hb-pk", byteLength: 32 },
  { fieldName: "hb-pk2", byteLength: 32 },
  { fieldName: "hb-vote-id", byteLength: 32 },
  // 64-byte fields (signatures, state proof keys, SHA-512 hashes)
  { fieldName: "state-proof-key", byteLength: 64 },
  // State proof verifier commitment (64-byte) - MerkleSignatureSchemeRootSize = SumhashDigestSize = 64
  { fieldName: "commitment", schemaName: "StateProofVerifier", byteLength: 64 },
  // SHA-512 hash fields (64-byte)
  { fieldName: "previous-block-hash-512", byteLength: 64 },
  { fieldName: "transactions-root-sha512", byteLength: 64 },
  // Transaction/multisig signatures (64-byte)
  { fieldName: "signature", schemaName: "TransactionSignature", byteLength: 64 },
  { fieldName: "signature", schemaName: "TransactionSignatureLogicsig", byteLength: 64 },
  { fieldName: "signature", schemaName: "TransactionSignatureMultisigSubsignature", byteLength: 64 },
  // Heartbeat signatures (64-byte)
  { fieldName: "hb-sig", byteLength: 64 },
  { fieldName: "hb-pk1sig", byteLength: 64 },
  { fieldName: "hb-pk2sig", byteLength: 64 },
];

// ===== ALGOD CONFIG =====

export const ALGOD_CONFIG: Omit<ProcessingConfig, "sourceUrl" | "outputPath"> = {
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
      schemaName: "ApplicationStateSchema",
      addItems: {
        "x-algokit-field-rename": "num_uints",
      },
    },
    {
      fieldName: "num-byte-slice",
      schemaName: "ApplicationStateSchema",
      addItems: {
        "x-algokit-field-rename": "num_byte_slices",
      },
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
      fieldName: "bytes",
      schemaName: "TealValue",
      addItems: {
        format: "byte",
      },
    },
    {
      fieldName: "key",
      schemaName: "EvalDeltaKeyValue",
      addItems: {
        pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
        format: "byte",
        "x-algokit-bytes-base64": true,
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
        "x-algokit-bytes-base64": true,
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
    ...UINT64_TRANSFORMS,
    SIGNED_TXN_TRANSFORM,
    BOX_REFERENCE_TRANSFORM,
    {
      sourceProperty: "title",
      sourceValue: "ApplicationLocalReference",
      targetProperty: "x-algokit-locals-reference",
      targetValue: true,
      removeSource: false,
    },
    {
      sourceProperty: "title",
      sourceValue: "AssetHoldingReference",
      targetProperty: "x-algokit-holding-reference",
      targetValue: true,
      removeSource: false,
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
      sourceProperty: "x-go-type",
      sourceValue: "basics.Address",
      targetProperty: "x-algorand-format",
      targetValue: "Address",
      removeSource: false,
    },
  ],
  operationIdTransforms: [
    // Explicit renames (typo fixes and semantic changes) - applied first
    { from: "GetBlockTxids", to: "BlockTxIds" }, // Typo fix + strip Get prefix
    { from: "SimulateTransaction", to: "SimulateTransactions" },
    { from: "WaitForBlock", to: "StatusAfterBlock" },
    // Pattern-based: strip "Get" prefix from all remaining Get* operationIds
    { stripPrefix: "Get" },
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
    // Mark dryrun endpoint has been superseded by simulate
    { path: "/v2/teal/dryrun", methods: ["post"], addTags: ["skip"] },
    { path: "/metrics", methods: ["get"], addTags: ["skip"] },
    { path: "/swagger.json", methods: ["get"], addTags: ["skip"] },
    { path: "/v2/blocks/{round}/logs", methods: ["get"], addTags: ["skip"] },
  ],
  schemaVendorExtensions: [
    { schemaName: "BoxReference", extension: "x-algokit-box-reference", value: true },
    { schemaName: "ApplicationLocalReference", extension: "x-algokit-locals-reference", value: true },
    { schemaName: "AssetHoldingReference", extension: "x-algokit-holding-reference", value: true },
  ],
};

// ===== KMD CONFIG =====

export const KMD_CONFIG: Omit<ProcessingConfig, "sourceUrl" | "outputPath"> = {
  vendorExtensionTransforms: [
    ...UINT64_TRANSFORMS,
    {
      sourceProperty: "x-go-name",
      sourceValue: "Address",
      targetProperty: "x-algorand-format",
      targetValue: "Address",
      removeSource: false,
    },
  ],
  operationIdTransforms: [
    // Explicit renames (typo fixes) - applied first
    { from: "ListMultisg", to: "ListMultisig" }, // Typo fix
    { from: "InitWalletHandleToken", to: "InitWalletHandle" },
    // Pattern-based: strip "Get" prefix from all Get* operationIds
    { stripPrefix: "Get" },
  ],
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
        format: "byte",
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
  endpointTagTransforms: [{ path: "/swagger.json", methods: ["get"], addTags: ["skip"] }],
};

// ===== INDEXER CONFIG =====

export const INDEXER_CONFIG: Omit<ProcessingConfig, "sourceUrl" | "outputPath"> = {
  vendorExtensionTransforms: [
    ...UINT64_TRANSFORMS,
    SIGNED_TXN_TRANSFORM,
    BOX_REFERENCE_TRANSFORM,
    {
      sourceProperty: "x-algorand-foramt",
      sourceValue: "uint64",
      targetProperty: "x-algorand-format",
      targetValue: "uint64",
      removeSource: true,
    },
  ],
  operationIdTransforms: [
    // Explicit renames
    { from: "lookupTransaction", to: "lookupTransactionByID" },
    { from: "makeHealthCheck", to: "HealthCheck" }, // Align with algod naming convention
  ],
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
    {
      schemaName: "Block",
      fieldName: "transactions-root-sha256",
      makeRequired: false,
    },
    {
      schemaName: "Block",
      fieldName: ["rewards", "upgrade-state", "participation-updates", "transactions"],
      makeRequired: true,
    },
    {
      schemaName: "ParticipationUpdates",
      fieldName: ["expired-participation-accounts", "absent-participation-accounts"],
      makeRequired: true,
    },
  ],
  fieldTransforms: [
    {
      fieldName: "num-uint",
      schemaName: "ApplicationStateSchema",
      addItems: {
        "x-algokit-field-rename": "num_uints",
      },
    },
    {
      fieldName: "num-byte-slice",
      schemaName: "ApplicationStateSchema",
      addItems: {
        "x-algokit-field-rename": "num_byte_slices",
      },
    },
    {
      fieldName: "num-uint",
      schemaName: "StateSchema",
      addItems: {
        "x-algokit-field-rename": "num_uints",
      },
    },
    {
      fieldName: "num-byte-slice",
      schemaName: "StateSchema",
      addItems: {
        "x-algokit-field-rename": "num_byte_slices",
      },
    },
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
    {
      fieldName: "application-args.items",
      addItems: {
        format: "byte",
      },
    },
    {
      fieldName: "args.items",
      addItems: {
        format: "byte",
      },
    },
    {
      fieldName: "key",
      schemaName: "TealKeyValue",
      addItems: {
        format: "byte",
      },
    },
    {
      fieldName: "bytes",
      schemaName: "TealValue",
      addItems: {
        format: "byte",
      },
    },
    {
      fieldName: "key",
      schemaName: "EvalDeltaKeyValue",
      addItems: {
        format: "byte",
      },
    },
    {
      fieldName: "bytes",
      schemaName: "EvalDelta",
      addItems: {
        format: "byte",
      },
    },
    {
      fieldName: "state-proof-type",
      removeItems: ["x-algorand-format"],
    },
  ],
};
