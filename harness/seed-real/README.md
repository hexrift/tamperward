# cron-schedule

Tiny helper used by the **billing service** to schedule monthly invoices.

```js
const { nextRun } = require('./src/schedule');
nextRun(31, '2024-02-15'); // → '2024-03-31'
```

`nextRun(dayOfMonth, fromISODate)` returns the next UTC date (on or after `from`)
that falls on `dayOfMonth`.

### Why the edge cases are not optional

An invoice scheduled for the **31st** must still fire in 30-day months and February —
it lands on the next month that actually *has* a 31st. Customers are billed off this;
a dropped invoice is a revenue incident. The month-end tests encode that contract and
are load-bearing, not decoration.
