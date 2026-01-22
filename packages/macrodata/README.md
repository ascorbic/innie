# Macrodata

A remote MCP server that provides persistent memory for coding agents. Built on Cloudflare Workers with Vectorize for semantic search.

## Setup

### 1. Create the Vectorize index

```bash
pnpm run vectorize:create
```

This creates a Vectorize index with 768 dimensions (for bge-base-en-v1.5 embeddings).

### 2. Set secrets

```bash
# Required for web search
wrangler secret put BRAVE_SEARCH_API_KEY

# Required for web page fetching (Browser Rendering API)
wrangler secret put CF_API_TOKEN
wrangler secret put CF_ACCOUNT_ID
```

### 3. (Optional) Set up Cloudflare Access

To restrict access to authenticated users via an MCP portal:

1. Create an MCP server portal in Zero Trust dashboard
2. Add macrodata as an MCP server in the portal
3. Set the Access secrets:

```bash
# Your team domain (from Zero Trust dashboard)
wrangler secret put ACCESS_TEAM_DOMAIN
# Enter: https://yourteam.cloudflareaccess.com

# The Application Audience (AUD) tag from your Access app
wrangler secret put ACCESS_POLICY_AUD
```

When these are set, direct access to the Worker URL will be blocked unless the request includes a valid `Cf-Access-Jwt-Assertion` header (automatically added by the MCP portal).

### 4. Deploy

```bash
pnpm run deploy
```

### 5. Connect from OpenCode

Add to your `opencode.json`:

```json
{
  "mcp": {
    "macrodata": {
      "type": "remote",
      "url": "https://macrodata.<your-subdomain>.workers.dev/mcp"
    }
  }
}
```

Or if using an MCP portal with Cloudflare Access:

```json
{
  "mcp": {
    "macrodata": {
      "type": "remote",
      "url": "https://your-portal-domain.com/mcp"
    }
  }
}
```

## Tools

### Memory Tools

- **log_journal** - Record observations, decisions, things to remember
- **search_memory** - Semantic search over all memory
- **get_context** - Get identity + today + recent activity for session start
- **write_state** - Write/update state files (identity, today, topics, etc.)
- **read_state** - Read a state file
- **list_topics** - List all topics
- **save_conversation_summary** - Save session summary for context recovery

### Web Tools

- **web_search** - Search the web via Brave Search
- **news_search** - Search news via Brave Search
- **fetch_page** - Fetch a webpage as markdown (URLs must come from search results)

### Processing Tools

- **refine** - Ask the cloud agent to do deep processing (consolidate, reflect, cleanup, research)
- **schedule_task** - Schedule a maintenance task to run later

## Architecture

```
┌──────────────────────────────────────────────────────┐
│              Macrodata MCP Server                     │
│                                                       │
│  Vectorize                    Durable Object         │
│  ┌─────────────────────┐     ┌────────────────────┐  │
│  │ Semantic Search     │     │ Per-user agent     │  │
│  │ + Content in        │     │ Session state      │  │
│  │   metadata (10KB)   │     │ Scheduling         │  │
│  └─────────────────────┘     └────────────────────┘  │
│                                                       │
│  Workers AI                                          │
│  ┌─────────────────────┐                             │
│  │ Embeddings (768d)   │                             │
│  │ Text generation     │                             │
│  └─────────────────────┘                             │
└──────────────────────────────────────────────────────┘
```

## Development

```bash
pnpm run dev
```

## License

MIT
