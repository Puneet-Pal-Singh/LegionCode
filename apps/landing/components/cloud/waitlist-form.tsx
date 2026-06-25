"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";

type FormState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export default function WaitlistForm() {
  const [state, setState] = useState<FormState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });
    const formElement = event.currentTarget;
    const form = new FormData(formElement);

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          company: form.get("company"),
          source: "cloud-page",
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readMessage(payload));
      setState({ status: "success", message: readMessage(payload) });
      formElement.reset();
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "We could not record your request. Please try again.",
      });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full" noValidate>
      <label htmlFor="waitlist-email" className="sr-only">
        Work email
      </label>
      <input
        id="waitlist-company"
        name="company"
        type="text"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-10000px] h-px w-px overflow-hidden"
      />
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-black/80 p-1.5 sm:flex-row">
        <input
          id="waitlist-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
          className="min-h-11 min-w-0 flex-1 bg-transparent px-4 font-mono text-xs text-white outline-none placeholder:text-zinc-600"
        />
        <button
          type="submit"
          disabled={state.status === "submitting" || state.status === "success"}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-white px-5 font-mono text-xs font-semibold text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {state.status === "submitting" ? "Requesting access" : "Request access"}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <p
        className={`mt-3 min-h-5 px-2 text-center font-mono text-[11px] ${
          state.status === "error" ? "text-red-400" : "text-zinc-500"
        }`}
        role="status"
        aria-live="polite"
      >
        {state.status === "success"
          ? state.message
          : state.status === "error"
            ? state.message
            : "Access is approved in limited batches."}
      </p>
    </form>
  );
}

function readMessage(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return "We could not record your request. Please try again.";
}
