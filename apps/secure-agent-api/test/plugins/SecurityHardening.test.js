import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateSessionId, isApiAvailable, sendCommand } from '../utils.js';

const API_AVAILABLE = await isApiAvailable();

describe('Plugin: Security Hardening', { skip: !API_AVAILABLE }, () => {
  const sessionId = generateSessionId();

  it('rejects command injection tokens in node run action', async () => {
    const result = await sendCommand(sessionId, 'node', {
      action: 'run',
      runId: sessionId,
      command: 'node; rm -rf /',
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error, /Unsafe shell token/i);
  });

  it('rejects filesystem path traversal outside workspace', async () => {
    const result = await sendCommand(sessionId, 'filesystem', {
      action: 'read_file',
      runId: sessionId,
      path: '../etc/passwd',
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error, /traversal|Access Denied/i);
  });

  it('validates git token format for auth path', async () => {
    const invalid = await sendCommand(sessionId, 'git', {
      action: 'git_push',
      runId: sessionId,
      branch: 'main',
      token: 'bad\ntoken',
    });
    assert.strictEqual(invalid.success, false);
    assert.match(invalid.error, /Invalid token format/i);
  });
});
