import type * as React from "react";
import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    // The wrapper scrolls, not the page: a wide table must never make the body scroll sideways.
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

const TableHeader = ({ className, ...props }: React.ComponentProps<"thead">) => (
  <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />
);
const TableBody = ({ className, ...props }: React.ComponentProps<"tbody">) => (
  <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />
);
const TableRow = ({ className, ...props }: React.ComponentProps<"tr">) => (
  <tr data-slot="table-row" className={cn("hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors", className)} {...props} />
);
const TableHead = ({ className, ...props }: React.ComponentProps<"th">) => (
  <th
    data-slot="table-head"
    className={cn("text-muted-foreground h-10 px-2 text-left align-middle text-xs font-medium tracking-wide uppercase whitespace-nowrap", className)}
    {...props}
  />
);
const TableCell = ({ className, ...props }: React.ComponentProps<"td">) => (
  <td data-slot="table-cell" className={cn("p-2 align-middle whitespace-nowrap", className)} {...props} />
);

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
