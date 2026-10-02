/**
 * Phase 1 Integration Test
 *
 * End-to-end test proving the complete context assembly pipeline works.
 * This is the acceptance test for Phase 1.
 */

import { describe, it, expect } from 'vitest';
import { ContextBuilder } from '../../ContextBuilder.js';

describe('Phase 1 Integration Test', () => {
  const builder = new ContextBuilder();

  it('should produce bounded context from message to final prompt (E2E)', async () => {
    // 1. User provides a message and intent
    const input: any = {
      userMessage: 'Add unit tests to the token-budgeting package',
      intent: { primary: 'implement', confidence: 'high', signals: [] },
      repoSummary: {
        rootPath: '/home/legioncode',
        scannedAt: '2024-01-01T00:00:00Z',
        totalFiles: 25,
        byKind: {},
        largestFiles: [],
        entryPoints: [],
        importantFiles: [],
        allFiles: [],
      },
      chatHistory: [
        {
          role: 'user' as const,
          content: 'What is this repo about?',
          timestamp: Date.now() - 10000,
        },
        {
          role: 'assistant' as const,
          content: 'This is LegionCode, a multi-agent IDE.',
          timestamp: Date.now() - 5000,
        },
      ],
    };

    // 2. Build context
    const output = await builder.build(input);

    // 3. Verify output structure
    expect(output).toBeDefined();
    expect(output.systemPrompt).toBeTruthy();
    expect(output.userPrompt).toBeTruthy();
    expect(output.contextBlocks).toBeDefined();
    expect(Array.isArray(output.contextBlocks)).toBe(true);
    expect(output.tokenReport).toBeDefined();
    expect(output.metadata).toBeDefined();

    // 4. Verify prompts are reasonable
    expect(output.systemPrompt.length).toBeGreaterThan(100);
    expect(output.userPrompt.length).toBeGreaterThan(0);

    // 5. Verify user message is included
    expect(output.userPrompt).toContain(input.userMessage);

    // 6. Verify token budget enforcement
    expect(output.tokenReport.totalUsed).toBeLessThanOrEqual(13500);

    // 7. Verify metadata
    expect(output.metadata.intent).toBe('implement');
    expect(output.metadata.strategyUsed).toBe('implement');
    expect(output.metadata.timestamp).toBeGreaterThan(0);

    // 8. Verify determinism
    const output2 = await builder.build(input);
    expect(JSON.stringify(output)).toBe(JSON.stringify(output2));
  });

  it('should handle explore intent correctly', async () => {
    const input: any = {
      userMessage: 'Show me the repo structure',
      intent: { primary: 'explore', confidence: 'high', signals: [] },
      repoSummary: {
        rootPath: '/home/repo',
        scannedAt: '2024-01-01T00:00:00Z',
        totalFiles: 15,
        byKind: {},
        largestFiles: [],
        entryPoints: [],
        importantFiles: [],
        allFiles: [],
      },
      chatHistory: [],
    };

    const output = await builder.build(input);

    // Explore should NOT include diffs
    const hasDiffs = output.contextBlocks.some(b => b.type === 'DIFFS');
    expect(hasDiffs).toBe(false);
  });

  it('should handle large context gracefully', async () => {
    const input: any = {
      userMessage: 'Document this codebase',
      intent: { primary: 'explore', confidence: 'high', signals: [] },
      repoSummary: {
        rootPath: '/huge/repo',
        scannedAt: '2024-01-01T00:00:00Z',
        totalFiles: 1000,
        byKind: {},
        largestFiles: [],
        entryPoints: [],
        importantFiles: [],
        allFiles: [],
      },
      chatHistory: [],
    };

    const output = await builder.build(input);

    // Should still be bounded
    expect(output.tokenReport.totalUsed).toBeLessThanOrEqual(13500);

    // Should handle gracefully
    expect(output.systemPrompt).toBeTruthy();
  });

  it('should produce consistent results across multiple intents', async () => {
    const intents = ['explore', 'bugfix', 'refactor', 'implement', 'review', 'meta'];

    for (const intent of intents) {
      const input: any = {
        userMessage: `This is a test for ${intent}`,
        intent: { primary: intent, confidence: 'high', signals: [] },
        repoSummary: {
          rootPath: '/repo',
          scannedAt: '2024-01-01T00:00:00Z',
          totalFiles: 5,
          byKind: {},
          largestFiles: [],
          entryPoints: [],
          importantFiles: [],
          allFiles: [],
        },
      };

      const output = await builder.build(input);

      // All outputs should be valid
      expect(output.systemPrompt).toBeTruthy();
      expect(output.userPrompt).toBeTruthy();
      expect(output.tokenReport.totalUsed).toBeLessThanOrEqual(13500);
      expect(output.metadata.intent).toBe(intent);
    }
  });
});
