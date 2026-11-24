/**
 * The recommended MCP server catalog the MCP settings page offers: remote
 * (streamable-http) endpoints only — a browser panel never defines commands
 * to spawn, and DSH has no OAuth flow, so only token-auth and no-auth
 * servers qualify. `about` and `tokenHelp` are text keys resolved by the
 * panel; serverName is the entry id.
 */
import { mcpCredentialName } from './contracts.ts'

export interface McpCatalogEntry {
  readonly id: string
  readonly name: string
  /** Text key of the one-line description. */
  readonly about: string
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly auth: 'none' | 'token'
  readonly tokenUrl?: string
  /** Text key of the token-creation hint. */
  readonly tokenHelp?: string
}

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    about: 'sMcpAbout_github',
    url: 'https://api.githubcopilot.com/mcp/readonly',
    headers: {
      Authorization: `Bearer \${credential:${mcpCredentialName('github')}}`,
      'X-MCP-Toolsets': 'repos,issues,pull_requests,actions',
    },
    auth: 'token',
    tokenUrl: 'https://github.com/settings/personal-access-tokens/new',
    tokenHelp: 'sMcpTokenHelp_github',
  },
  { id: 'deepwiki', name: 'DeepWiki', about: 'sMcpAbout_deepwiki', url: 'https://mcp.deepwiki.com/mcp', auth: 'none' },
  { id: 'context7', name: 'Context7', about: 'sMcpAbout_context7', url: 'https://mcp.context7.com/mcp', auth: 'none' },
  { id: 'exa', name: 'Exa', about: 'sMcpAbout_exa', url: 'https://mcp.exa.ai/mcp', auth: 'none' },
  { id: 'mslearn', name: 'Microsoft Learn', about: 'sMcpAbout_mslearn', url: 'https://learn.microsoft.com/api/mcp', auth: 'none' },
  { id: 'cloudflare-docs', name: 'Cloudflare Docs', about: 'sMcpAbout_cloudflare', url: 'https://docs.mcp.cloudflare.com/mcp', auth: 'none' },
  { id: 'huggingface', name: 'Hugging Face', about: 'sMcpAbout_huggingface', url: 'https://huggingface.co/mcp', auth: 'none' },
]
