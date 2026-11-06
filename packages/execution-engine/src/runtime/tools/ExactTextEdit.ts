export interface ExactTextEditInput {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  expectedReplacements?: number;
}

export function replaceExactText(
  content: string,
  input: ExactTextEditInput,
): { content: string; count: number } {
  const count = countOccurrences(content, input.oldText);
  if (count === 0) {
    throw new Error(`Exact edit text was not found in ${input.path}`);
  }
  if (!input.replaceAll && count !== 1) {
    throw new Error(
      `Exact edit is ambiguous in ${input.path}: found ${count} matches`,
    );
  }
  if (
    input.expectedReplacements !== undefined &&
    count !== input.expectedReplacements
  ) {
    throw new Error(
      `Expected ${input.expectedReplacements} replacement match(es) in ${input.path}, found ${count}`,
    );
  }
  const nextContent = input.replaceAll
    ? content.split(input.oldText).join(input.newText)
    : content.replace(input.oldText, input.newText);
  return { content: nextContent, count: input.replaceAll ? count : 1 };
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor <= content.length - needle.length) {
    const match = content.indexOf(needle, cursor);
    if (match < 0) {
      break;
    }
    count += 1;
    cursor = match + needle.length;
  }
  return count;
}
