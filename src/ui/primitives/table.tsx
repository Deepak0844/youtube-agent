import * as React from "react";
import { cn } from "../lib/cn";

/** List-screen pattern (Doc 3 §6): left-aligned, 12 px grey headers, 1 px row rules, no zebra. */
export const Table = ({ className, ...p }: React.ComponentProps<"table">) => (
  <table className={cn("w-full border-collapse text-left text-body", className)} {...p} />
);
export const TableHeader = (p: React.ComponentProps<"thead">) => <thead {...p} />;
export const TableBody = (p: React.ComponentProps<"tbody">) => <tbody {...p} />;
export const TableRow = ({ className, ...p }: React.ComponentProps<"tr">) => (
  <tr className={cn("border-b border-rule", className)} {...p} />
);
export const TableHead = ({ className, ...p }: React.ComponentProps<"th">) => (
  <th scope="col" className={cn("px-2 py-2 text-small font-normal text-faint first:pl-0", className)} {...p} />
);
export const TableCell = ({ className, ...p }: React.ComponentProps<"td">) => (
  <td className={cn("min-w-0 px-2 py-3 align-middle break-words first:pl-0", className)} {...p} />
);
