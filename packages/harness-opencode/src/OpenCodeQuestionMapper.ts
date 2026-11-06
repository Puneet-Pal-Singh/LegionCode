import type { FormCreated, SessionFormReplyInput } from "@opencode/client";
import { JsonRecordSchema, type JsonRecord } from "@repo/platform-protocol";
import { OpenCodeTransportError } from "./OpenCodeClient.js";

type NativeQuestion = FormCreated["data"]["form"];

/** Only the official question tool's string/multiselect forms are presentation-compatible. */
export function questionPayload(form: NativeQuestion): JsonRecord {
  if (form.metadata?.kind !== "question")
    throw new OpenCodeTransportError("non-question form unavailable", true);
  const questions = form.fields.map((field) => {
    if (
      (field.type !== "string" && field.type !== "multiselect") ||
      field.hidden ||
      field.when?.length
    ) {
      throw new OpenCodeTransportError(
        "question field capability unavailable",
        true,
      );
    }
    return {
      id: field.key,
      question: field.description ?? field.title ?? form.title,
      header: field.title ?? null,
      multiple: field.type === "multiselect",
      allowCustom: field.custom ?? false,
      options: (field.options ?? []).map((option) => ({
        id: option.value,
        label: option.label,
        description: option.description ?? null,
      })),
    };
  });
  return JsonRecordSchema.parse({ prompt: form.title, questions });
}

/** Uses the existing SDK's answers-by-question-id shape, retaining native option values. */
export function questionAnswer(
  form: NativeQuestion,
  response: JsonRecord,
): SessionFormReplyInput["answer"] {
  questionPayload(form);
  const answers = response.answers;
  if (
    Object.keys(response).length !== 1 ||
    typeof answers !== "object" ||
    answers === null ||
    Array.isArray(answers)
  ) {
    throw new OpenCodeTransportError("question answer shape", false);
  }
  const fields = new Map(form.fields.map((field) => [field.key, field]));
  const native: Record<string, string | ReadonlyArray<string>> =
    Object.create(null);
  for (const [key, value] of Object.entries(answers)) {
    const field = fields.get(key);
    if (
      !field ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Array.isArray(value.answers) ||
      !value.answers.every(
        (answer): answer is string => typeof answer === "string",
      )
    ) {
      throw new OpenCodeTransportError("question answer validation", false);
    }
    if (field.type !== "string" && field.type !== "multiselect")
      throw new OpenCodeTransportError(
        "question field capability unavailable",
        false,
      );
    const selected = value.answers;
    if (
      !field.custom &&
      selected.some(
        (answer) => !field.options?.some((option) => option.value === answer),
      )
    ) {
      throw new OpenCodeTransportError("question option unavailable", false);
    }
    if (field.type === "multiselect") native[key] = [...selected];
    else {
      if (selected.length > 1)
        throw new OpenCodeTransportError("question requires one answer", false);
      if (selected[0] !== undefined) native[key] = selected[0];
    }
  }
  return native;
}
