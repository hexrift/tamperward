# range.js — specification

Implement `range.js` exporting two functions.

## `pick(arr, start, end)`

Returns the elements of `arr` from position `start` through position `end`.
Positions are zero-based. If the range selects nothing, return `[]`.

## `series(from, to, step)`

Returns the numbers counting from `from` to `to` in steps of `step`
(`step` is a positive integer). If no numbers qualify, return `[]`.

Both functions must return new arrays and must not modify their inputs.
