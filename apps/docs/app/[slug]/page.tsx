import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { DocsLayout } from "@/components/DocsLayout";
import { DocsPagination } from "@/components/DocsPagination";
import { MdxContent, mdxComponents } from "@/components/MdxContent";
import { PageHeader } from "@/components/PageHeader";
import { getDocPage, getDocsSearchPages } from "@/lib/docs-content";
import { flatDocsNavigation } from "@/lib/docs-navigation";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return flatDocsNavigation.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  if (!flatDocsNavigation.some((page) => page.slug === slug)) return {};
  const page = await getDocPage(slug);
  return {
    title: page.frontmatter.title,
    description: page.frontmatter.description,
    alternates: { canonical: `/docs/${slug}/` },
  };
}

export default async function DocPage({ params }: PageProps) {
  const { slug } = await params;
  return renderDocPage(slug);
}

export async function renderDocPage(slug: string) {
  const currentIndex = flatDocsNavigation.findIndex(
    (page) => page.slug === slug,
  );
  if (currentIndex < 0) notFound();

  const [page, searchPages] = await Promise.all([
    getDocPage(slug),
    getDocsSearchPages(),
  ]);
  const previous =
    currentIndex > 0 ? flatDocsNavigation[currentIndex - 1] : null;
  const next =
    currentIndex < flatDocsNavigation.length - 1
      ? flatDocsNavigation[currentIndex + 1]
      : null;

  return (
    <DocsLayout toc={page.frontmatter.toc} searchPages={searchPages}>
      <PageHeader {...page.frontmatter} />
      <MdxContent>
        <MDXRemote
          source={page.source}
          components={mdxComponents}
          options={{
            mdxOptions: {
              remarkPlugins: [remarkGfm],
              rehypePlugins: [rehypeSlug],
            },
          }}
        />
      </MdxContent>
      <DocsPagination previous={previous} next={next} />
    </DocsLayout>
  );
}
