"use client";

interface TimeFilterProps {
  minDate: string;
  maxDate: string;
  range: [number, number];
  maxOffset: number;
  onChange: (range: [number, number]) => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function offsetToDate(minDate: string, offset: number): string {
  const d = new Date(minDate);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

export function TimeFilter({
  minDate,
  range,
  maxOffset,
  onChange,
}: TimeFilterProps) {
  const startDate = offsetToDate(minDate, range[0]);
  const endDate = offsetToDate(minDate, range[1]);
  const fullRange = range[0] === 0 && range[1] === maxOffset;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wide">
          Date Range
        </h3>
        {!fullRange && (
          <button
            onClick={() => onChange([0, maxOffset])}
            className="text-xs text-stone-500 hover:text-stone-300 underline"
          >
            Reset
          </button>
        )}
      </div>
      <div className="text-xs text-stone-300 font-mono mb-2 text-center">
        {formatDate(startDate)} &mdash; {formatDate(endDate)}
      </div>
      <div className="space-y-2 px-1">
        <div>
          <label className="text-[10px] text-stone-500 uppercase">Start</label>
          <input
            type="range"
            min={0}
            max={maxOffset}
            value={range[0]}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              onChange([Math.min(v, range[1]), range[1]]);
            }}
            className="w-full accent-amber-600"
          />
        </div>
        <div>
          <label className="text-[10px] text-stone-500 uppercase">End</label>
          <input
            type="range"
            min={0}
            max={maxOffset}
            value={range[1]}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              onChange([range[0], Math.max(v, range[0])]);
            }}
            className="w-full accent-amber-600"
          />
        </div>
      </div>
    </div>
  );
}
