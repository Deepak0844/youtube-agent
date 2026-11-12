"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import * as M from "@radix-ui/react-dropdown-menu";
import { CircleUser, LogOut, Monitor, Moon, Sun, UserRound } from "lucide-react";
import { cn, fade, focusRing } from "../lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../primitives/dropdown-menu";
import { applyTheme, parseTheme, readTheme, type ThemeChoice } from "../theme";

const THEMES = [
  { value: "system", label: "System (follow the Mac)", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

/** Account menu: the Account page, the theme choice and Sign out. `signOut` is the logout server action, passed from the server layout. */
export function AccountMenu({ signOut }: { signOut: () => Promise<void> }) {
  const form = useRef<HTMLFormElement>(null);
  const [theme, setTheme] = useState<ThemeChoice>("system");
  return (
    <>
      <form ref={form} action={signOut} hidden />
      <DropdownMenu onOpenChange={(open) => open && setTheme(readTheme())}>
        <DropdownMenuTrigger
          aria-label="Account"
          className={cn("flex size-11 items-center justify-center rounded-control text-muted hover:bg-raised hover:text-text md:size-9", fade, focusRing)}
        >
          <CircleUser size={20} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem asChild>
            <Link href="/settings/account">
              <UserRound size={15} aria-hidden className="text-muted" />
              Account
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="flex items-center justify-between gap-3 px-2.5 py-1.5">
            <DropdownMenuLabel className="p-0 text-body font-normal text-text">Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              aria-label="Theme"
              value={theme}
              onValueChange={(v) => {
                const t = parseTheme(v);
                applyTheme(t);
                setTheme(t);
              }}
              className="flex gap-0.5 rounded-full border border-border p-0.5"
            >
              {THEMES.map(({ value, label, Icon }) => (
                <M.RadioItem
                  key={value}
                  value={value}
                  aria-label={label}
                  title={label}
                  onSelect={(e) => e.preventDefault()} // keep the menu open so the change can be seen
                  className="flex h-6 w-7 cursor-default items-center justify-center rounded-full text-muted outline-none data-[highlighted]:text-text data-[state=checked]:bg-raised data-[state=checked]:text-text data-[state=checked]:ring-1 data-[state=checked]:ring-border"
                >
                  <Icon size={14} aria-hidden />
                </M.RadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => form.current?.requestSubmit()}>
            <LogOut size={15} aria-hidden className="text-muted" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
