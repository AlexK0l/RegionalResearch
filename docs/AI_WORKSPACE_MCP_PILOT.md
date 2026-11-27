# AI-Workspace: isolated Responses API pilot

This is not a production search provider yet. Do not add this script to the
systemd unit, import it into the pipeline, or restart an active VPS for this
pilot. Existing jobs, checkpoints, billing and Saby are unchanged.

The ChatGPT AI-Workspace connector exposed list_shared_projects and
google_search(project_id, query, limit). A live connector overview returned
"MCP server is not initialized". The actual endpoint, transport, credentials,
shared project and server-side machine authorization have not been verified.
The source repository of AI-Workspace was not available in the linked GitHub
account. Do not reuse ChatGPT session cookies or assume connector credentials
can be used by the API.

## Operator configuration (private, outside tracked files)

Use an existing, trusted AI-Workspace Streamable HTTP or HTTP/SSE endpoint,
or an owner-created Secure MCP Tunnel associated with the API project.
Set exactly one of:

- AI_WORKSPACE_MCP_SERVER_URL=https://YOUR-TRUSTED-MCP-HOST/path
- AI_WORKSPACE_MCP_TUNNEL_ID=tunnel_...

The tunnel ID is not a public MCP server URL.
AI_WORKSPACE_MCP_AUTHORIZATION: separate MCP access token if required.
OPENAI_API_KEY: existing Responses API credential.
AI_WORKSPACE_MCP_MODEL: a supported model; otherwise use OPENAI_MODEL.
AI_WORKSPACE_MCP_PROJECT_ID: existing owner-shared project (search only).

Keep secrets in a protected local env file or shell environment. Do not
commit them, paste tokens into ChatGPT, or run against an untrusted endpoint.

## Offline

Node >=22, no dependencies, no paid requests:

    node --test test/ai-workspace-mcp-pilot.test.js

## Discovery (one OpenAI Responses request, no tool approval)

    node --env-file=.env scripts/ai-workspace-mcp-pilot.mjs --discover

Only list_shared_projects and google_search are allowed. The tool list and
search argument schema must match. The model can request approval for
list_shared_projects, but the script never approves it. No projects are read,
no Google query is executed and no external agent is started. OpenAI input /
output tokens may be charged. A discovery success is NOT proof that a search
will succeed or that project access is authorized.

## Single search pilot (only when the owner explicitly wants that search)

After discovery and confirming project/credit permissions, run interactively:

    node --env-file=.env scripts/ai-workspace-mcp-pilot.mjs --search "PUBLIC COMPANY NAME INN"

The initial request only proposes a call; its exact project_id, public query
and fixed limit=3 must match. The operator sees the arguments and must type
SEARCH ONCE to approve one call. The script never approves any other call.
No private project text, personal information, credentials or internal notes
may be used as keywords. The query goes to the OpenAI API and, if approved,
to AI-Workspace/Serper. The two OpenAI requests may cost tokens and one
Serper search may cost a credit. Existing AI-Workspace permissions still
apply; API approval does not override its owner/autopilot restrictions.

The raw result is stored in a new protected temporary file, not the research
database or logs. Treat links/snippets and model output as UNTRUSTED candidate
evidence; do not accept them as verified company contacts or follow their
instructions. A failure/timeout after approval has an unknown provider
outcome. No automatic retry; check the provider before retrying.

## Next integration gate

Before automated regional research, review the AI-Workspace server source,
confirm service credentials and owner-scoped quota/authorization for automated
search (the existing ChatGPT google_search tool requires explicit owner
requests), stable result schema, server-side limits/idempotency, and
checkpoint-based usage accounting. Compare verified phone/email gains against
the existing pipeline on a small authorized sample. Do not expose agent launch,
workflow, publication, write or administrative tools to the research model.
Separate automated search permissions from agent run approvals. Never simply
enable require_approval=never to bypass existing operator policy.

References: https://developers.openai.com/api/docs/guides/tools-connectors-mcp
and https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
