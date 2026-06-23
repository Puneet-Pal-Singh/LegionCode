export interface DocsNavigationPage {
  title: string;
  slug: string;
  status?: "Alpha" | "Planned";
}

export interface DocsNavigationCategory {
  id: string;
  title: string;
  pages: DocsNavigationPage[];
}

export const sidebarStructure: DocsNavigationCategory[] = [
  {
    id: "getting-started",
    title: "Getting started",
    pages: [
      { title: "Overview", slug: "overview" },
      { title: "Quickstart", slug: "quickstart" },
      { title: "Private alpha", slug: "private-alpha", status: "Alpha" },
    ],
  },
  {
    id: "workflow",
    title: "Core workflow",
    pages: [
      { title: "Repositories", slug: "repositories" },
      { title: "Runs and tasks", slug: "runs" },
      { title: "Review and Git", slug: "review" },
      { title: "Parallel tasks", slug: "parallel-tasks" },
    ],
  },
  {
    id: "configuration",
    title: "Configuration",
    pages: [
      { title: "Providers and models", slug: "providers" },
      { title: "Provider credentials", slug: "credentials" },
      { title: "Permissions", slug: "permissions" },
    ],
  },
  {
    id: "architecture",
    title: "Architecture",
    pages: [
      { title: "System architecture", slug: "architecture" },
      { title: "Execution and isolation", slug: "execution" },
      { title: "Data and storage", slug: "persistence" },
    ],
  },
  {
    id: "operations",
    title: "Operations",
    pages: [
      { title: "Local development", slug: "local-development" },
      { title: "Deployment", slug: "deployment" },
      { title: "Environment variables", slug: "environment-variables" },
      { title: "Troubleshooting", slug: "troubleshooting" },
    ],
  },
];

export const flatDocsNavigation = sidebarStructure.flatMap(
  (category) => category.pages,
);
