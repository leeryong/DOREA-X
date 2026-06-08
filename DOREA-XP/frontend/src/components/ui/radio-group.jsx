"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

function RadioGroup({ value, onValueChange, className, children, ...props }) {
  return (
    <div
      data-slot="radio-group"
      role="radiogroup"
      className={cn("flex gap-3", className)}
      {...props}
    >
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child, { _selected: value, _onSelect: onValueChange })
          : child
      )}
    </div>
  )
}

function RadioGroupItem({ value, _selected, _onSelect, className, children, id, ...props }) {
  const checked = _selected === value
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex items-center gap-2 cursor-pointer select-none",
        className
      )}
    >
      <span
        className={cn(
          "size-4 shrink-0 rounded-full border shadow-xs transition-shadow outline-none",
          "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input dark:bg-input/30"
        )}
      >
        <input
          type="radio"
          id={id}
          value={value}
          checked={checked}
          onChange={() => _onSelect?.(value)}
          className="sr-only"
          {...props}
        />
        {checked && (
          <span className="flex items-center justify-center size-full">
            <span className="size-1.5 rounded-full bg-current" />
          </span>
        )}
      </span>
      {children}
    </label>
  )
}

export { RadioGroup, RadioGroupItem }
