'use strict';

/**
 * A store whose options were renamed does not fail loudly: it trims history with
 * `undefined`, which becomes either an invalid `ZREMRANGEBYRANK 0 NaN` argument
 * on Redis or an empty room in memory, and every message afterwards looks lost.
 * Catching a config mistake here is cheaper than reading it as data loss.
 */
function requireOptions(label, values) {
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${label} needs ${name} as a positive integer, received ${value}`);
    }
  }
}

module.exports = { requireOptions };
