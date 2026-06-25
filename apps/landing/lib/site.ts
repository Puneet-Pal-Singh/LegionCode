export const site = {
  name: "LegionCode",
  url: "https://legioncode.dev",
  description:
    "Open-source workspace for running coding-agent tasks in isolated cloud sandboxes and reviewing every changed file.",
  githubUrl: "https://github.com/Puneet-Pal-Singh/LegionCode",
  ogImage: "/assets/legioncode-og.png",
} as const;

export const docsRoutes = [
  "overview",
  "quickstart",
  "private-alpha",
  "repositories",
  "runs",
  "review",
  "parallel-tasks",
  "providers",
  "credentials",
  "permissions",
  "architecture",
  "execution",
  "persistence",
  "local-development",
  "deployment",
  "environment-variables",
  "troubleshooting",
  "changelog",
] as const;

export const productStructuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: site.name,
  url: site.url,
  description: site.description,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  codeRepository: site.githubUrl,
  license: "https://opensource.org/license/mit",
  featureList: [
    "Isolated cloud workspaces for coding-agent runs",
    "Configurable model providers",
    "Review-first file changes",
  ],
} as const;
