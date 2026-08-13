/**
 * The origami mark.
 *
 * Loaded as an <img> from public/ rather than inlined as JSX: the glyph is 5 paths and ~4KB, so
 * inlining it would put that in every bundle for no benefit, and a separate file gets cached.
 * The asset uses `currentColor`, but an <img> cannot inherit that — so the two themes are
 * handled with a CSS filter instead, which is cheaper than shipping two files.
 */
export function Mark({ className = "" }: { className?: string }) {
  return (
    <img
      src="/dashboard/ori-mark.svg"
      alt=""
      aria-hidden="true"
      // invert in dark mode so the dark glyph reads on a dark surface
      className={`select-none dark:invert ${className}`}
      draggable={false}
    />
  );
}
