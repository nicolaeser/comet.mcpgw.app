export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export type McpProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export function isSupportedProtocolVersion(
  value: string,
): value is McpProtocolVersion {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(value as McpProtocolVersion);
}

export function supportsJsonRpcBatching(version: McpProtocolVersion): boolean {
  return version === "2025-03-26" || version === "2024-11-05";
}

export function supportsStructuredToolOutput(
  version: McpProtocolVersion,
): boolean {
  return version === "2025-11-25" || version === "2025-06-18";
}

export function supportsTasks(version: McpProtocolVersion): boolean {
  return version === "2025-11-25";
}
