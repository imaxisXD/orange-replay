import { useState } from "react";
import type { SessionFilter } from "@orange-replay/shared";
import { InputField, InputGroup } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { StatsBreakdownRow } from "@/lib/api/stats";
import { AlertCircle, Angry, Calendar, Clock, Filter, Global } from "@/lib/icon-map";
import {
  dateRangeFilter,
  dateRangeOptions,
  selectedDateRange,
  type DateRangeValue,
} from "@/lib/session-filters";

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
  onFilterChange,
}: {
  countries: readonly StatsBreakdownRow[];
  countryQueryFailed: boolean;
  countryQueryPending: boolean;
  filter: SessionFilter;
  onFilterChange: (filter: SessionFilter) => void;
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

  const range = selectedDateRange(filter);

  return (
    <section
      aria-labelledby="sessions-filter-heading"
      className="grid grid-cols-2 items-center gap-3 sm:flex sm:flex-wrap"
      data-sessions-toolbar
    >
      <h2
        className="col-span-2 flex h-9 items-center gap-1.5 text-[13px] font-medium text-muted-foreground sm:h-8.5 sm:shrink-0 sm:text-[12px]"
        id="sessions-filter-heading"
      >
        <Filter aria-hidden className="size-4 shrink-0" strokeWidth={1.5} />
        Filters
      </h2>

      <Select
        onValueChange={(value) =>
          onFilterChange(dateRangeFilter(filter, value as DateRangeValue, Date.now()))
        }
        value={range === "custom" ? undefined : range}
      >
        <SelectTrigger
          aria-label="Date range"
          className="h-9 w-full min-w-0 rounded-[7px] border border-border bg-secondary px-3 text-[13px] sm:h-8.5 sm:w-40 sm:min-w-40 sm:shrink-0 sm:text-[12px]"
          icon={Calendar}
          placeholder={range === "custom" ? "Custom range" : "Last 24 hours"}
        />
        <SelectContent className="rounded-lg border border-border bg-popover">
          <SelectGroup>
            {dateRangeOptions.map((option, index) => (
              <SelectItem index={index} key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <CountryPicker
        countries={countries}
        onCommit={(country) =>
          onFilterChange({ ...filter, country: country.length === 0 ? undefined : country })
        }
        queryFailed={countryQueryFailed}
        queryPending={countryQueryPending}
        value={filter.country ?? ""}
      />

      {/* Third of three dropdowns, so on the two-column grid it would sit alone
          beside an empty cell. `SelectTrigger` renders its own wrapper div —
          that wrapper, not the trigger, is the grid item — so the span has to
          live on an element this file owns. At `sm` and up the section is a
          flex row and this div is sized by its content, exactly as the bare
          Select was. */}
      <div className="col-span-2 sm:col-auto" data-duration-cell>
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
            className="h-9 w-full min-w-0 rounded-[7px] border border-border bg-secondary px-3 text-[13px] sm:h-8.5 sm:w-44 sm:min-w-44 sm:shrink-0 sm:text-[12px]"
            icon={Clock}
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
      </div>

      {/* The two lenses are one group. They are borderless, so only space can
          separate them: `gap-x-6` keeps them twice as far apart as the 10px
          each switch puts between its own label and track, and `ms-auto`
          (logical, not `ml-auto`) parks the whole pair on the trailing edge in
          both directions. `col-span-2` keeps the pair on its own row on
          narrow screens instead of letting the grid pair one lens with a
          dropdown. */}
      <div
        className="col-span-2 flex flex-wrap items-center gap-x-6 gap-y-2 sm:col-auto sm:ms-auto"
        data-lens-group
      >
        <Switch
          checked={filter.has_errors === true}
          className="min-h-11 rounded-none border-0 bg-transparent px-0 py-0 sm:min-h-0"
          icon={AlertCircle}
          iconClassName={filter.has_errors === true ? "text-danger" : "text-danger/70"}
          label="Errors only"
          labelFirst
          size="small"
          onToggle={() =>
            onFilterChange({
              ...filter,
              has_errors: filter.has_errors === true ? undefined : true,
            })
          }
        />

        <Switch
          checked={filter.has_rage === true}
          className="min-h-11 rounded-none border-0 bg-transparent px-0 py-0 sm:min-h-0"
          icon={Angry}
          iconClassName={filter.has_rage === true ? "text-amber" : "text-amber/70"}
          label="Rage clicks only"
          labelFirst
          size="small"
          onToggle={() =>
            onFilterChange({
              ...filter,
              has_rage: filter.has_rage === true ? undefined : true,
            })
          }
        />
      </div>
    </section>
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
        className="h-9 w-full min-w-0 rounded-[7px] border border-border bg-secondary px-3 text-[13px] sm:h-8.5 sm:w-44 sm:min-w-44 sm:shrink-0 sm:text-[12px]"
        icon={Global}
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

  // Same width as the CountryPicker select it stands in for, so losing the
  // stats query does not shift every control after it.
  return (
    <InputGroup className="w-full gap-0 sm:w-44">
      <InputField
        hideLabel
        icon={Global}
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
