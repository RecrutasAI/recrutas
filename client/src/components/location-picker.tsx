import { useEffect, useMemo, useRef, useState } from "react";
import { MapPin, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Pick a US place: every Census place with how many live jobs it has, plus states and Remote
 * (client/public/us-places.json, loaded on first focus). The filter applies only when a place
 * is chosen, by click or Enter on a suggestion, never while typing, so "s" filters nothing.
 * The value is "City, ST", a state code, or "Remote": what the server matches on (shared/places.ts).
 */

type Row = [name: string, state: string, jobs: number];
interface PlaceData { places: Row[]; states: Row[] }

export interface PlaceOption { value: string; label: string; detail: string; jobs: number; kind: 'place' | 'state' | 'remote' }

let dataPromise: Promise<PlaceData> | null = null;
function loadPlaces(): Promise<PlaceData> {
  if (!dataPromise) {
    dataPromise = fetch('/us-places.json').then(r => {
      if (!r.ok) {throw new Error(`places ${r.status}`);}
      return r.json();
    }).catch(err => { dataPromise = null; throw err; });
  }
  return dataPromise;
}

const norm = (s: string) => s.toLowerCase().replace(/\bsaint\b/g, 'st').replace(/\bfort\b/g, 'ft').replace(/\bmount\b/g, 'mt')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const jobsLabel = (n: number) => (n === 0 ? 'no jobs yet' : `${n.toLocaleString('en-US')} job${n === 1 ? '' : 's'}`);

/** Suggestions for what was typed: exact names first, then names starting with it, then any word starting with it; most jobs first. */
export function suggestPlaces(query: string, data: PlaceData, limit = 8): PlaceOption[] {
  const q = norm(query.split(',')[0]);
  const stateHint = query.includes(',') ? query.split(',').slice(1).join(' ').trim().toUpperCase() : '';
  if (q.length < 2) {return [];}
  const out: Array<PlaceOption & { rank: number }> = [];
  if ('remote'.startsWith(q)) {out.push({ value: 'Remote', label: 'Remote', detail: 'remote jobs', jobs: Infinity, kind: 'remote', rank: 0 });}
  for (const [name, st, jobs] of data.states) {
    const n = norm(name);
    const exactCode = q.length === 2 && q.toUpperCase() === st;
    if (exactCode || n.startsWith(q)) {
      out.push({ value: st, label: `${name} (state)`, detail: jobsLabel(jobs), jobs, kind: 'state', rank: exactCode || n === q ? 0 : 1 });
    }
  }
  for (const [name, st, jobs] of data.places) {
    if (stateHint && !st.startsWith(stateHint.slice(0, 2))) {continue;}
    const n = norm(name);
    const rank = n === q ? 0 : n.startsWith(q) ? 1 : n.split(' ').some(w => w.startsWith(q)) ? 2 : -1;
    if (rank < 0) {continue;}
    out.push({ value: `${name}, ${st}`, label: `${name}, ${st}`, detail: jobsLabel(jobs), jobs, kind: 'place', rank });
  }
  return out
    .sort((a, b) => a.rank - b.rank || b.jobs - a.jobs || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** What the box shows for a chosen value: "Washington (state)" for "WA", the value otherwise. */
export function placeLabel(value: string, data?: PlaceData | null): string {
  if (/^[A-Z]{2}$/.test(value) && data) {
    const st = data.states.find(s => s[1] === value);
    if (st) {return `${st[0]} (state)`;}
  }
  return value;
}

interface LocationPickerProps {
  /** The chosen place, or '' for none. */
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
}

export function LocationPicker({ value, onChange, className, placeholder = "City, state or Remote" }: LocationPickerProps) {
  const [data, setData] = useState<PlaceData | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const ensureData = () => {
    if (data || failed) {return;}
    loadPlaces().then(setData).catch(() => setFailed(true));
  };
  // The box shows the chosen place whenever it changes (a pick, or clear filters). The place
  // list arriving later only fills in a state's name ("WA" → "Washington (state)"); it never
  // replaces what the person is typing.
  useEffect(() => { setText(value ? placeLabel(value, data) : ''); }, [value]);
  useEffect(() => { if (data && value) {setText(t => (t === value ? placeLabel(value, data) : t));} }, [data]);
  useEffect(() => { if (value) {ensureData();} }, [value]);

  const options = useMemo(() => (data && open ? suggestPlaces(text, data) : []), [data, open, text]);
  useEffect(() => { setActive(0); }, [text]);

  const choose = (opt: PlaceOption) => {
    onChange(opt.value);
    setText(opt.kind === 'state' ? opt.label : opt.value);
    setOpen(false);
  };
  // Leaving the box without choosing puts back what is applied: typing alone never filters.
  const revert = () => { setOpen(false); setText(value ? placeLabel(value, data) : ''); };

  return (
    <div
      ref={boxRef}
      className={cn("relative", className)}
      onBlur={(e) => { if (!boxRef.current?.contains(e.relatedTarget as Node)) {revert();} }}
    >
      <MapPin className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
      <Input
        type="text"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls="location-picker-list"
        aria-autocomplete="list"
        aria-label="Location"
        placeholder={placeholder}
        className={cn("pl-9 h-10", value && "pr-8")}
        value={text}
        onFocus={() => { ensureData(); setOpen(true); }}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, options.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter') {
            e.preventDefault();
            // Enter takes the highlighted place once the name is clear: 3+ letters, an exact
            // state code ("WA"), or a place the arrow keys moved to.
            const opt = options[active];
            if (opt && (norm(text).length >= 3 || active > 0 || (opt.kind === 'state' && opt.value === text.trim().toUpperCase()))) {choose(opt);}
          } else if (e.key === 'Escape') { revert(); }
        }}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear location"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={() => { onChange(''); setText(''); setOpen(false); }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {open && text.trim().length >= 2 && (
        <ul
          id="location-picker-list"
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full min-w-[240px] overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md"
        >
          {!data && !failed && <li className="px-2 py-1.5 text-muted-foreground">Loading places…</li>}
          {failed && <li className="px-2 py-1.5 text-muted-foreground">Couldn't load places. Try again.</li>}
          {data && options.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">No US place by that name</li>}
          {options.map((opt, i) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              className={cn("flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5", i === active && "bg-accent")}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(opt)}
            >
              <span className="truncate">{opt.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{opt.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
