import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { flatDocsNavigation } from "@/lib/docs-navigation";

export type DocStatus = "alpha" | "planned" | "draft";

export interface DocTocItem {
  id: string;
  text: string;
}

export interface DocFrontmatter {
  title: string;
  description: string;
  category: string;
  status?: DocStatus;
  toc: DocTocItem[];
}

export interface DocPageContent {
  slug: string;
  frontmatter: DocFrontmatter;
  source: string;
}

export interface DocsSearchPage {
  slug: string;
  title: string;
  description: string;
  category: string;
  content: string;
}

const contentDirectory = path.resolve(process.cwd(), "content", "docs");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToc(value: unknown, slug: string): DocTocItem[] {
  if (!Array.isArray(value)) {
    throw new Error(`[docs/content] ${slug}: frontmatter.toc must be an array`);
  }

  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.text !== "string"
    ) {
      throw new Error(
        `[docs/content] ${slug}: invalid toc item at index ${index}`,
      );
    }
    return { id: item.id, text: item.text };
  });
}

function parseFrontmatter(value: unknown, slug: string): DocFrontmatter {
  if (!isRecord(value)) {
    throw new Error(`[docs/content] ${slug}: frontmatter is required`);
  }

  const { title, description, category, status } = value;
  if (
    typeof title !== "string" ||
    typeof description !== "string" ||
    typeof category !== "string"
  ) {
    throw new Error(
      `[docs/content] ${slug}: title, description, and category are required`,
    );
  }
  if (
    status !== undefined &&
    status !== "alpha" &&
    status !== "planned" &&
    status !== "draft"
  ) {
    throw new Error(`[docs/content] ${slug}: invalid status`);
  }

  return {
    title,
    description,
    category,
    status,
    toc: parseToc(value.toc, slug),
  };
}

function toSearchText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_`>[\]()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function getDocPage(slug: string): Promise<DocPageContent> {
  const filePath = resolveDocFilePath(slug);
  const file = await readFile(filePath, "utf8");
  const parsed = matter(file);
  return {
    slug,
    frontmatter: parseFrontmatter(parsed.data as unknown, slug),
    source: parsed.content,
  };
}

export async function getDocsSearchPages(): Promise<DocsSearchPage[]> {
  return Promise.all(
    flatDocsNavigation.map(async ({ slug }) => {
      const page = await getDocPage(slug);
      return {
        slug,
        title: page.frontmatter.title,
        description: page.frontmatter.description,
        category: page.frontmatter.category,
        content: toSearchText(page.source),
      };
    }),
  );
}

function resolveDocFilePath(slug: string): string {
  const safeSlug = slug.replace(/\\/g, "/");
  if (!/^[a-z0-9-]+$/i.test(safeSlug)) {
    throw new Error(`[docs/content] ${slug}: invalid slug`);
  }

  const filePath = path.resolve(contentDirectory, `${safeSlug}.mdx`);
  if (!filePath.startsWith(`${contentDirectory}${path.sep}`)) {
    throw new Error(`[docs/content] ${slug}: path traversal blocked`);
  }
  return filePath;
}
