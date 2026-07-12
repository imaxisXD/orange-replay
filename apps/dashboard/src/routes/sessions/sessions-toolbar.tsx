import { useState } from "react";
import type { SessionFilter } from "@orange-replay/shared";
import { Button } from "@/components/ui/button";
import { InputField, InputGroup } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import type { StatsBreakdownRow } from "@/lib/api/stats";
import { RotateCcw, Search } from "@/lib/icon-map";
import { dateRangeShorthand, formatSessionCount } from "@/lib/session-count";

const minDurationOptions = [
  { label: "Any duration", value: "any", ms: undefined },
  { label: "30 seconds", value: "30000", ms: 30_000 },
  { label: "1 minute", value: "60000", ms: 60_000 },
  { label: "5 minutes", value: "300000", ms: 300_000 },
] as const;

export function SessionsToolbar({
  countries,
  countryQueryFailed,
  countryQueryPending,
  filter,
  hasMore,
  isLoading,
  isRefreshing,
  onFilterChange,
  onRefresh,
  sessionCount,
}: {
  countries: readonly StatsBreakdownRow[];
  countryQueryFailed: boolean;
  countryQueryPending: boolean;
  filter: SessionFilter;
  hasMore: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  onFilterChange: (filter: SessionFilter) => void;
  onRefresh: () => void;
  sessionCount: number;
}) {
  const minDurationValue =
    filter.min_duration_ms === undefined ? "any" : String(filter.min_duration_ms);
  const durationOptions = minDurationOptions.some((option) => option.value === minDurationValue)
    ? minDurationOptions
    : [
        ...minDurationOptions,
        {
          label: `At least ${Math.round((filter.min_duration_ms ?? 0) / 1000)} seconds`,
          value: minDurationValue,
          ms: filter.min_duration_ms,
        },
      ];

  return (
    <div className="grid grid-cols-2 items-center gap-2.5 sm:flex sm:flex-wrap">
      <CountryPicker
        countries={countries}
        onCommit={(country) =>
          onFilterChange({ ...filter, country: country.length === 0 ? undefined : country })
        }
        queryFailed={countryQueryFailed}
        queryPending={countryQueryPending}
        value={filter.country ?? ""}
      />

      <Select
        onValueChange={(value) =>
          onFilterChange({
            ...filter,
            min_duration_ms: value === "any" ? undefined : Number(value),
          })
        }
        value={minDurationValue}
      >
        <SelectTrigger
          aria-label="Minimum duration"
          className="h-9 w-full min-w-0 rounded-[7px] border border-border bg-secondary px-3 text-[13px] sm:h-8.5 sm:min-w-40 sm:text-[12px]"
          placeholder="Any duration"
        />
        <SelectContent className="rounded-lg border border-border bg-popover">
          <SelectGroup>
            {durationOptions.map((option, index) => (
              <SelectItem index={index} key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <Switch
        checked={filter.has_errors === true}
        className="min-h-11 px-0 py-0 sm:min-h-0"
        label="Has errors"
        onToggle={() =>
          onFilterChange({
            ...filter,
            has_errors: filter.has_errors === true ? undefined : true,
          })
        }
      />

      <Switch
        checked={filter.has_rage === true}
        className="min-h-11 px-0 py-0 sm:min-h-0"
        label="Has rage"
        onToggle={() =>
          onFilterChange({
            ...filter,
            has_rage: filter.has_rage === true ? undefined : true,
          })
        }
      />

      <div className="hidden flex-1 sm:block" />

      <div className="col-span-2 flex items-center justify-end gap-2 sm:contents">
        <span className="font-mono text-[12px] text-muted-foreground sm:text-[11.5px]">
          {isRefreshing ? "Refreshing…" : formatSessionCount(sessionCount, hasMore)}
          {!isRefreshing && rangeSuffix(filter)}
        </span>
        <Tooltip content={isRefreshing ? "Refreshing sessions" : "Refresh"}>
          <Button
            aria-label={isRefreshing ? "Refreshing sessions" : "Refresh sessions"}
            className="text-muted-foreground hover:text-foreground"
            disabled={isLoading}
            loading={isRefreshing}
            onClick={onRefresh}
            size="icon-sm"
            variant="ghost"
          >
            <RotateCcw aria-hidden className="size-4" />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

function CountryPicker({
  countries,
  onCommit,
  queryFailed,
  queryPending,
  value,
}: {
  countries: readonly StatsBreakdownRow[];
  onCommit: (country: string) => void;
  queryFailed: boolean;
  queryPending: boolean;
  value: string;
}) {
  // Recognition over recall: offer the countries that actually exist in the
  // data instead of demanding ISO codes from memory. The free-text input
  // stays as the fallback while stats are unavailable.
  if (queryFailed || (queryPending && value.length > 0)) {
    return <CountryFilter onCommit={onCommit} value={value} />;
  }

  const knownValue = value.length === 0 || countries.some((row) => row.label === value);

  return (
    <Select
      onValueChange={(next) => onCommit(next === "all" ? "" : next)}
      value={value.length === 0 ? "all" : value}
    >
      <SelectTrigger
        aria-label="Country"
        className="h-9 w-full min-w-0 rounded-[7px] border border-border bg-secondary px-3 text-[13px] sm:h-8.5 sm:min-w-36 sm:text-[12px]"
        placeholder="All countries"
      />
      <SelectContent className="rounded-lg border border-border bg-popover">
        <SelectGroup>
          <SelectItem index={0} value="all">
            All countries
          </SelectItem>
          {countries.map((row, index) => (
            <SelectItem index={index + 1} key={row.label} value={row.label}>
              {row.label}
            </SelectItem>
          ))}
          {!knownValue && (
            <SelectItem index={countries.length + 1} value={value}>
              {value}
            </SelectItem>
          )}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function CountryFilter({
  onCommit,
  value,
}: {
  onCommit: (country: string) => void;
  value: string;
}) {
  const [input, setInput] = useState(value);

  function commitCountry(nextValue: string): void {
    const cleanValue = nextValue.trim();
    if (cleanValue.length === 0 || cleanValue.length === 2) {
      onCommit(cleanValue);
    }
  }

  return (
    <InputGroup className="w-full gap-0 sm:w-40">
      <InputField
        hideLabel
        icon={Search}
        index={0}
        label="Country code"
        maxLength={2}
        onBlur={() => commitCountry(input)}
        onChange={(nextValue) => {
          const upperValue = nextValue.toUpperCase();
          setInput(upperValue);
          commitCountry(upperValue);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commitCountry(input);
        }}
        placeholder="Country code"
        value={input}
      />
    </InputGroup>
  );
}

function rangeSuffix(filter: { from?: number; to?: number }): string {
  const range = dateRangeShorthand(filter);
  return range === null ? "" : ` · ${range}`;
}
