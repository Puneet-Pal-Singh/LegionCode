/**
 * FileFormatter - Pure string serialization for files
 *
 * Single responsibility: Convert FileDescriptor to string representation
 * No truncation, no decisions, pure serialization
 */
import type { FileDescriptor } from "@legioncode/context-assembly";

export interface FileFormatOptions {
  includePath?: boolean;
  includeLanguage?: boolean;
}

export function formatFile(
  file: FileDescriptor,
  options: FileFormatOptions = {},
): string {
  const { includePath = true, includeLanguage = true } = options;
  const parts: string[] = [];

  if (includePath) {
    parts.push(`--- File: ${file.path} ---`);
  }

  if (includeLanguage && file.language) {
    parts.push(`Language: ${file.language}`);
  }

  if (file.content) {
    parts.push(file.content);
  }

  return parts.join("\n");
}

export function formatFiles(
  files: FileDescriptor[],
  options?: FileFormatOptions,
): string {
  if (files.length === 0) {
    return "";
  }

  return files.map((file) => formatFile(file, options)).join("\n\n");
}
