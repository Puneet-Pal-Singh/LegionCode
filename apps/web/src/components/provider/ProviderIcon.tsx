import type { IconType } from "react-icons";
import {
  SiAnthropic,
  SiCloudflare,
  SiGoogle,
  SiOpencode,
  SiOpenrouter,
  SiVercel,
} from "react-icons/si";
import { AiOutlineOpenAI } from "react-icons/ai";
import { Cpu } from "lucide-react";
import { cn } from "../../lib/utils";

const BRAND_ICONS: Record<string, IconType> = {
  anthropic: SiAnthropic,
  "cloudflare-ai": SiCloudflare,
  google: SiGoogle,
  openai: AiOutlineOpenAI,
  "opencode-go": SiOpencode,
  "opencode-zen": SiOpencode,
  openrouter: SiOpenrouter,
  vercel: SiVercel,
};

const PROVIDER_MONOGRAMS: Record<string, string> = {
  cerebras: "C",
  together: "T",
};

export function ProviderIcon({
  providerId,
  className,
}: {
  providerId: string;
  className?: string;
}): React.ReactElement {
  const BrandIcon = BRAND_ICONS[providerId];
  const monogram = PROVIDER_MONOGRAMS[providerId];

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center text-zinc-300",
        className,
      )}
    >
      {BrandIcon ? (
        <BrandIcon size={17} />
      ) : monogram ? (
        <span className="text-sm font-semibold tracking-tight">{monogram}</span>
      ) : (
        <Cpu size={17} />
      )}
    </span>
  );
}
