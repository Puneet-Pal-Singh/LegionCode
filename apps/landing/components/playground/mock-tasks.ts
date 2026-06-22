import { MockTask } from './types';

export const MOCK_TASKS: Record<string, MockTask> = {
  'onboarding': {
    id: 'onboarding',
    title: 'Add repository onboarding flow',
    timeAgo: 'just now',
    duration: '1m 24s',
    fileName: 'apps/web/components/repo-picker.tsx',
    changes: { added: 47, removed: 9 },
    message: 'Added repository connection flow with GitHub OAuth, validated empty states, and updated onboarding copy.',
    filesList: [
      { name: 'apps/web/app/onboarding/page.tsx', added: 84, removed: 12 },
      { name: 'apps/web/components/repo-picker.tsx', added: 47, removed: 9 },
      { name: 'apps/web/lib/github.ts', added: 28, removed: 4 }
    ],
    diffLines: [
      { type: 'neutral', lineNum: 10, code: 'export function RepoPicker() {' },
      { type: 'neutral', lineNum: 11, code: '  const { user } = useAuth();' },
      { type: 'deletion', lineNum: 12, code: '-   const [loading, setLoading] = useState(false);' },
      { type: 'addition', lineNum: 13, code: '+   // Connect GitHub repository' },
      { type: 'addition', lineNum: 14, code: '+   const repo = await connectGithubRepository(id);' },
      { type: 'addition', lineNum: 15, code: '+' },
      { type: 'addition', lineNum: 16, code: '+   // Select default branch' },
      { type: 'addition', lineNum: 17, code: '+   const branch = repo.branches.find(b => b.isDefault);' },
      { type: 'addition', lineNum: 18, code: '+' },
      { type: 'addition', lineNum: 19, code: '+   // Create isolated workspace' },
      { type: 'addition', lineNum: 20, code: '+   await createIsolatedWorkspace(repo.id, branch.name);' },
      { type: 'neutral', lineNum: 21, code: '   return <WorkspaceSuccess />;' }
    ]
  },
  'execution': {
    id: 'execution',
    title: 'Polishing secure worker sandbox API',
    timeAgo: '15m ago',
    duration: '8m 12s',
    fileName: 'apps/secure-agent-api/src/index.ts',
    changes: { added: 14, removed: 2 },
    message: 'Orchestrated Sandboxed runtime sessions and local verification curl interfaces. Added baseline validation checks to verify local runtime fingerprints prior to handling execution requests.',
    filesList: [
      { name: 'apps/secure-agent-api/src/index.ts', added: 14, removed: 2 },
      { name: 'apps/secure-agent-api/src/sandbox.ts', added: 32, removed: 8 },
      { name: 'apps/secure-agent-api/package.json', added: 6, removed: 1 }
    ],
    diffLines: [
      { type: 'neutral', lineNum: 42, code: 'export default {' },
      { type: 'neutral', lineNum: 43, code: '  async fetch(request, env) {' },
      { type: 'deletion', lineNum: 44, code: '-     return new Response("OK");' },
      { type: 'addition', lineNum: 45, code: '+     const url = new URL(request.url);' },
      { type: 'addition', lineNum: 46, code: '+     if (url.pathname === "/api/debug/runtime") {' },
      { type: 'addition', lineNum: 47, code: '+       return Response.json({' },
      { type: 'addition', lineNum: 48, code: '+         status: "healthy",' },
      { type: 'addition', lineNum: 49, code: '+         runtime: "cloudflare-worker",' },
      { type: 'addition', lineNum: 50, code: '+         bootTimestamp: Date.now(),' },
      { type: 'addition', lineNum: 51, code: '+         fingerprint: env.RUNTIME_GIT_SHA || "local-dev"' },
      { type: 'addition', lineNum: 52, code: '+       });' },
      { type: 'addition', lineNum: 53, code: '+     }' },
      { type: 'neutral', lineNum: 54, code: '     return handleNextRouting(request, env);' }
    ]
  },
  'readme': {
    id: 'readme',
    title: 'Sync Private Alpha README.md',
    timeAgo: '1h ago',
    duration: '4m 30s',
    fileName: 'README.md',
    changes: { added: 45, removed: 5 },
    message: 'Updated architecture layout blocks, launch postures, check:boundaries instructions, and prerequisites for local verification workspaces.',
    filesList: [
      { name: 'README.md', added: 45, removed: 5 },
      { name: 'docs/architecture.md', added: 80, removed: 5 },
      { name: 'docs/setup.md', added: 24, removed: 2 }
    ],
    diffLines: [
      { type: 'neutral', lineNum: 1, code: '# LegionCode' },
      { type: 'deletion', lineNum: 2, code: '- Local console playground' },
      { type: 'addition', lineNum: 3, code: '+ A coding-agent workspace built on a custom Cloudflare-native execution harness.' },
      { type: 'addition', lineNum: 4, code: '+' },
      { type: 'addition', lineNum: 5, code: '+ ## Launch Posture' },
      { type: 'addition', lineNum: 6, code: '+ LegionCode is currently in **Private Alpha**.' }
    ]
  },
  'verification': {
    id: 'verification',
    title: 'Run validation gates',
    timeAgo: '3h ago',
    duration: '22s',
    fileName: 'package.json',
    changes: { added: 3, removed: 0 },
    message: 'Added validation scripts for package boundaries and type checks so workspace contracts stay consistent across apps.',
    filesList: [
      { name: 'package.json', added: 3, removed: 0 },
      { name: '.dependency-cruiser.json', added: 15, removed: 2 },
      { name: 'tsconfig.json', added: 8, removed: 0 }
    ],
    diffLines: [
      { type: 'neutral', lineNum: 12, code: '  "scripts": {' },
      { type: 'addition', lineNum: 13, code: '    "check:boundaries": "dependency-cruiser --config .dependency-cruiser.json apps packages",' },
      { type: 'addition', lineNum: 14, code: '    "check-types": "pnpm --recursive exec tsc --noEmit",' },
      { type: 'neutral', lineNum: 15, code: '    "lint": "eslint ."' }
    ]
  }
};
