export type ChangelogCategory = "product" | "providers" | "platform";

export interface ChangelogSection {
  category: ChangelogCategory;
  title: string;
  items: string[];
}

export interface ChangelogHighlight {
  category: ChangelogCategory;
  title: string;
  description: string;
}

export interface ChangelogRelease {
  id: string;
  title: string;
  date: string;
  phase?: "development" | "launch";
  highlights?: ChangelogHighlight[];
  sections: ChangelogSection[];
  pullRequests?: number[];
  commits?: string[];
}
