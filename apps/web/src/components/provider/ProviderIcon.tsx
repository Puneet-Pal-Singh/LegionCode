import type { IconType } from "react-icons";
import {
  SiAnthropic,
  SiCloudflare,
  SiGoogle,
  SiOpenrouter,
  SiVercel,
} from "react-icons/si";
import { Bot, Cpu, Sparkles } from "lucide-react";
import { cn } from "../../lib/utils";

const BRAND_ICONS: Record<string, IconType> = {
  anthropic: SiAnthropic,
  "cloudflare-ai": SiCloudflare,
  google: SiGoogle,
  openrouter: SiOpenrouter,
  vercel: SiVercel,
};

export function ProviderIcon({
  providerId,
  className,
}: {
  providerId: string;
  className?: string;
}): React.ReactElement {
  const BrandIcon = BRAND_ICONS[providerId];
  const FallbackIcon =
    providerId === "openai"
      ? Bot
      : providerId.includes("opencode")
        ? Sparkles
        : Cpu;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center text-zinc-300",
        className,
      )}
    >
      {BrandIcon ? <BrandIcon size={17} /> : <FallbackIcon size={17} />}
    </span>
  );
}
