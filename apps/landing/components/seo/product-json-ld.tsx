import { productStructuredData } from "@/lib/site";

export default function ProductJsonLd() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(productStructuredData).replace(/</g, "\\u003c"),
      }}
    />
  );
}
