import { useState } from "react";
import { cleanCountryCode } from "@/lib/country";
import { cn } from "@/lib/utils";

interface CountryFlagProps {
  className?: string;
  country: string | null | undefined;
}

export function CountryFlag({ className, country }: CountryFlagProps) {
  const code = cleanCountryCode(country);
  const [failedCode, setFailedCode] = useState<string | null>(null);
  if (code === null) return null;

  if (failedCode === code) {
    return (
      <span
        aria-label={`${code} flag`}
        className={cn(
          "inline-flex h-3.25 min-w-5 flex-none items-center justify-center overflow-hidden rounded-[2px] border border-border bg-secondary px-0.75 font-mono text-[8px] leading-none text-dim",
          className,
        )}
        role="img"
        title={code}
      >
        {code}
      </span>
    );
  }

  return (
    <span
      aria-label={`${code} flag`}
      className={cn(
        "inline-flex h-3.25 w-5 flex-none overflow-hidden rounded-[2px] border border-border bg-secondary shadow-[0_0_0_1px_rgba(0,0,0,0.34)]",
        className,
      )}
      role="img"
      title={code}
    >
      <img
        alt=""
        aria-hidden
        className="block size-full object-cover"
        decoding="async"
        loading="lazy"
        onError={() => setFailedCode(code)}
        src={`/flags/${code}.svg`}
      />
    </span>
  );
}
