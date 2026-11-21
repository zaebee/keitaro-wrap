import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, "..");
const repoRoot = resolve(frontendDir, "..");
const output = resolve(frontendDir, "src/api/generated/openapi.ts");

const pythonCode = [
  "import json",
  "from app.main import app",
  "print(json.dumps(app.openapi()))",
].join("; ");

const schemaResult = spawnSync("uv", ["run", "python", "-c", pythonCode], { // NOSONAR
  cwd: repoRoot,
  encoding: "utf8",
});

if (schemaResult.status !== 0) {
  throw new Error(
    `failed to read wrapper runtime OpenAPI: ${schemaResult.stderr || schemaResult.stdout}`,
  );
}

const schema = JSON.parse(schemaResult.stdout);
if (!schema.openapi || schema.info?.title !== "Keitaro Wrap") {
  throw new Error("unexpected OpenAPI document; expected the FastAPI wrapper schema");
}

const WRAPPER_SCHEMAS = [
  "OperationStatus",
  "CreateCampaignRequest",
  "CampaignCreationResponse",
  "StreamRefResponse",
  "FetchOutcomeResponse",
  "CommittedStateResponse",
  "StreamBindingResponse",
  "RemoteSnapshotResponse",
  "RemoteOfferResponse",
  "DraftStateResponse",
  "DraftViewResponse",
  "StagedOfferResponse",
  "ConflictDetailResponse",
  "AcceptRemoteRequest",
  "ConflictResolutionResponse",
  "DraftCommandResultResponse",
  "PolicyCase",
  "OfferDraftRequest",
  "AddDraftRequest",
  "RemoveDraftRequest",
  "RestoreDraftRequest",
  "PinDraftRequest",
  "SetShareDraftRequest",
  "CancelDraftRequest",
  "PublicationStatus",
  "OfferEntryResponse",
  "PublicPublicationResponse",
  "PublicationStateResponse",
  "CancelResultResponse",
  "RecoveryResultResponse",
  "PushResultResponse",
  "PushStreamOutcomeResponse",
  "HTTPValidationError",
  "ValidationError",
];

function refName(ref) {
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) {
    throw new Error(`unsupported schema reference: ${ref}`);
  }
  return ref.slice(prefix.length);
}

function tsType(node) {
  if (!node || typeof node !== "object") {
    return "unknown";
  }
  if (node.$ref) {
    return refName(node.$ref);
  }
  if (Array.isArray(node.enum)) {
    return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (Array.isArray(node.anyOf)) {
    const nullable = node.anyOf.some((item) => item.type === "null");
    const parts = node.anyOf
      .filter((item) => item.type !== "null")
      .map(tsType);
    if (nullable) {
      parts.push("null");
    }
    return parts.length === 1 ? parts[0] : `(${parts.join(" | ")})`;
  }
  switch (node.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `${tsType(node.items)}[]`;
    case "object":
      return "Record<string, unknown>";
    default:
      return "unknown";
  }
}

function emitSchema(name, node) {
  const properties = node.properties;
  if (node.type !== "object" || !properties) {
    return `export type ${name} = ${tsType(node)};`;
  }
  const required = new Set(node.required ?? []);
  const lines = Object.entries(properties).map(([key, value]) => {
    const property = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    const optional = required.has(key) ? "" : "?";
    return `  ${property}${optional}: ${tsType(value)};`;
  });
  return [`export interface ${name} {`, ...lines, "}"].join("\n");
}

const declarations = WRAPPER_SCHEMAS.map((name) => {
  const node = schema.components?.schemas?.[name];
  if (!node) {
    throw new Error(`runtime OpenAPI is missing component schema ${name}`);
  }
  return emitSchema(name, node);
});

const source = [
  "/**",
  " * Generated from the wrapper runtime OpenAPI (`app.openapi()`), scoped to S8 contracts.",
  " * Run `bun run generate:api` from `frontend/` to regenerate.",
  " * Do not edit manually; docs/openapi.json is the Keitaro Admin API snapshot.",
  " */",
  "",
  ...declarations.flatMap((declaration) => [declaration, ""]),
].join("\n");

await mkdir(dirname(output), { recursive: true });
await writeFile(output, source, "utf8");
console.log(`wrote ${output} (${schema.info.title} ${schema.info.version})`);
