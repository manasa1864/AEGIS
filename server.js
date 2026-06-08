/**
 * Aegis MCP Bridge Server
 *
 * Acts as an MCP client that connects to the GitLab MCP server and exposes
 * REST endpoints the Aegis frontend can call. This satisfies the hackathon's
 * "partner MCP server" requirement for the GitLab track.
 *
 * Usage: node server.js
 * Requires: GITLAB_URL env var (default: https://gitlab.com)
 */

import express from 'express';
import cors from 'cors';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:3000', /\.vercel\.app$/] }));
app.use(express.json());

// MCP client pool keyed by gitlab token (one connection per token)
const pool = new Map();

async function getClient(gitlabToken) {
  if (pool.has(gitlabToken)) return pool.get(gitlabToken);

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@gitlabhq/gitlab-mcp@latest', '--transport', 'stdio'],
    env: {
      ...process.env,
      GITLAB_PERSONAL_ACCESS_TOKEN: gitlabToken,
      GITLAB_URL: process.env.GITLAB_URL || 'https://gitlab.com',
    },
  });

  const client = new Client(
    { name: 'aegis', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  await client.connect(transport);

  transport.onclose = () => pool.delete(gitlabToken);

  pool.set(gitlabToken, client);
  return client;
}

function token(req) {
  return req.headers['x-gitlab-token'] || '';
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aegis-mcp-bridge' }));

// ── List available MCP tools ──────────────────────────────────────────────────
app.get('/api/mcp/tools', async (req, res) => {
  const pat = token(req);
  if (!pat) return res.status(401).json({ error: 'x-gitlab-token header required' });
  try {
    const client = await getClient(pat);
    const result = await client.listTools();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Generic MCP tool call ─────────────────────────────────────────────────────
app.post('/api/mcp/call', async (req, res) => {
  const pat = token(req);
  if (!pat) return res.status(401).json({ error: 'x-gitlab-token header required' });
  const { tool, params } = req.body;
  if (!tool) return res.status(400).json({ error: 'tool name required' });
  try {
    const client = await getClient(pat);
    const result = await client.callTool({ name: tool, arguments: params ?? {} });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitLab Issues via MCP ─────────────────────────────────────────────────────
app.get('/api/mcp/gitlab/issues', async (req, res) => {
  const pat = token(req);
  if (!pat) return res.status(401).json({ error: 'x-gitlab-token header required' });
  const { project_id, state = 'opened' } = req.query;
  try {
    const client = await getClient(pat);
    const result = await client.callTool({
      name: 'list_issues',
      arguments: { project_id, state, per_page: 30 },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mcp/gitlab/issues', async (req, res) => {
  const pat = token(req);
  if (!pat) return res.status(401).json({ error: 'x-gitlab-token header required' });
  const { project_id, title, description } = req.body;
  try {
    const client = await getClient(pat);
    const result = await client.callTool({
      name: 'create_issue',
      arguments: { project_id, title, description },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/mcp/gitlab/issues/:iid', async (req, res) => {
  const pat = token(req);
  if (!pat) return res.status(401).json({ error: 'x-gitlab-token header required' });
  const { project_id, state_event } = req.body;
  try {
    const client = await getClient(pat);
    const result = await client.callTool({
      name: 'update_issue',
      arguments: { project_id, issue_iid: parseInt(req.params.iid), state_event },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitLab Pipelines via MCP ──────────────────────────────────────────────────
app.get('/api/mcp/gitlab/pipelines', async (req, res) => {
  const pat = token(req);
  if (!pat) return res.status(401).json({ error: 'x-gitlab-token header required' });
  const { project_id, status } = req.query;
  try {
    const client = await getClient(pat);
    const result = await client.callTool({
      name: 'list_pipelines',
      arguments: { project_id, ...(status ? { status } : {}), per_page: 25 },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitLab Merge Requests via MCP ─────────────────────────────────────────────
app.get('/api/mcp/gitlab/mrs', async (req, res) => {
  const pat = token(req);
  if (!pat) return res.status(401).json({ error: 'x-gitlab-token header required' });
  const { project_id, state = 'opened' } = req.query;
  try {
    const client = await getClient(pat);
    const result = await client.callTool({
      name: 'list_merge_requests',
      arguments: { project_id, state, per_page: 25 },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mcp/gitlab/mrs', async (req, res) => {
  const pat = token(req);
  if (!pat) return res.status(401).json({ error: 'x-gitlab-token header required' });
  const { project_id, title, description, source_branch, target_branch } = req.body;
  try {
    const client = await getClient(pat);
    const result = await client.callTool({
      name: 'create_merge_request',
      arguments: { project_id, title, description, source_branch, target_branch },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GitLab Project info via MCP ───────────────────────────────────────────────
app.get('/api/mcp/gitlab/project', async (req, res) => {
  const pat = token(req);
  if (!pat) return res.status(401).json({ error: 'x-gitlab-token header required' });
  const { project_id } = req.query;
  try {
    const client = await getClient(pat);
    const result = await client.callTool({
      name: 'get_project',
      arguments: { project_id },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Aegis MCP Bridge on port ${PORT}`);
  console.log(`GitLab MCP: http://localhost:${PORT}/api/mcp/`);
});
