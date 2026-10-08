import { sha256 } from './canonical';

/**
 * Deterministic provider-side service execution. No LLM, no external calls —
 * the demo must be reproducible on stage. The innovation is the enforcement
 * boundary, not the sophistication of the agent.
 */
export function executeService(serviceName: string, requestId: string): Record<string, unknown> {
  switch (serviceName) {
    case 'AI Translation':
      return { task: 'translate', engine: 'DemoMT-1', source: 'Hello world', target: 'Hola mundo' };
    case 'Compute Job':
      return { task: 'aggregate.sum', dataset: [4, 8, 15, 16, 23, 42], claimedSum: 108 };
    case 'Data Storage': {
      const payload = `spendoath-demo-payload:${requestId}`;
      return { task: 'object.store', objectId: `obj_${requestId.slice(-8)}`, payload, checksum: sha256(payload) };
    }
    case 'Premium Code Audit':
      return {
        task: 'code.audit',
        language: 'javascript',
        // Deliberately vulnerable artifact: missing lower-bound clamp.
        claim: 'clamp() violates its lower bound: clamp(-5) returns -5 instead of clamping to 0',
        source: 'function clamp(x) { return x > 10 ? 10 : x; }',
      };
    default:
      return { task: 'generic.echo', input: requestId };
  }
}