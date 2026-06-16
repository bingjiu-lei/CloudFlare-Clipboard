import { writeFileSync } from "node:fs";

const required = ["D1_DATABASE_ID"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length) {
  console.error(`Missing required build environment variable: ${missing.join(", ")}`);
  process.exit(1);
}

const workerName = process.env.WORKER_NAME || "cloudflare-clipboard";
const databaseName = process.env.D1_DATABASE_NAME || "clipboard";
const databaseId = process.env.D1_DATABASE_ID;
const accessDockBaseUrl = process.env.ACCESSDOCK_BASE_URL || "https://auth.leiyun.blog";

const config = `name = "${escapeToml(workerName)}"
main = "src/index.js"
compatibility_date = "2026-06-16"

[observability]
enabled = true

[vars]
ACCESSDOCK_BASE_URL = "${escapeToml(accessDockBaseUrl)}"

[[d1_databases]]
binding = "CLIPBOARD_DB"
database_name = "${escapeToml(databaseName)}"
database_id = "${escapeToml(databaseId)}"
`;

writeFileSync("wrangler.generated.toml", config);
console.log("Generated wrangler.generated.toml");

function escapeToml(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
