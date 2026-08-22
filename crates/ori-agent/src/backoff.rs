//! Jittered exponential reconnect backoff.
//!
//! After a control-plane restart, a few hundred sandboxes all wake up and try
//! to reconnect at once. A fixed or purely exponential delay lines them up and
//! becomes a reconnect storm — a real outage for the plane that just came back.
//! This uses the AWS "full jitter" policy: the *base* delay doubles per
//! attempt up to a cap, and each actual delay is drawn uniformly in `[0, base]`
//! so the cohort spreads out over the backoff window instead of thundering in
//! together.

use std::time::Duration;

/// Defaults tuned for a guest fleet: start reconnecting almost immediately,
/// top out at a minute, and never all hammer at the same instant.
pub const DEFAULT_MIN: Duration = Duration::from_millis(500);
pub const DEFAULT_MAX: Duration = Duration::from_secs(60);
pub const DEFAULT_FACTOR: f64 = 2.0;

/// Full-jitter exponential backoff.
#[derive(Debug, Clone)]
pub struct Backoff {
    min_ms: u64,
    max_ms: u64,
    factor: f64,
    attempt: u32,
    rng: XorShift64,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new(DEFAULT_MIN, DEFAULT_MAX, DEFAULT_FACTOR)
    }
}

impl Backoff {
    /// Build a backoff seeded from the clock.
    pub fn new(min: Duration, max: Duration, factor: f64) -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9e37_79b9_7f4a_7c15);
        Self::with_seed(min, max, factor, seed)
    }

    /// Build a backoff with an explicit seed (deterministic, for tests).
    pub fn with_seed(min: Duration, max: Duration, factor: f64, seed: u64) -> Self {
        Self {
            min_ms: min.as_millis() as u64,
            max_ms: max.as_millis() as u64,
            factor: factor.max(1.0),
            attempt: 0,
            rng: XorShift64(seed.max(1)),
        }
    }

    /// Exponential base delay for the current attempt, capped at `max`.
    pub fn base_ms(&self) -> u64 {
        let exp = self.factor.powi(self.attempt.min(60) as i32);
        let raw = self.min_ms as f64 * exp;
        (raw as u64).min(self.max_ms)
    }

    /// Draw the next delay and advance the attempt counter.
    pub fn next(&mut self) -> Duration {
        let base = self.base_ms();
        self.attempt = self.attempt.saturating_add(1);
        let ms = if base == 0 {
            0
        } else {
            self.rng.next_u64_below(base)
        };
        Duration::from_millis(ms)
    }

    /// Reset after a connection that survived long enough to count as healthy.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

/// Minimal 64-bit xorshift PRNG. Kept dependency-free so the guest binary stays
/// small; cryptographic quality is irrelevant for choosing a sleep duration.
#[derive(Debug, Clone)]
struct XorShift64(u64);

impl XorShift64 {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// Uniform value in `[0, bound)`.
    fn next_u64_below(&mut self, bound: u64) -> u64 {
        debug_assert!(bound > 0);
        // Rejection-free multiply-high to avoid modulo bias.
        (((self.next_u64() as u128) * (bound as u128)) >> 64) as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_delay_grows_exponentially_up_to_cap() {
        let mut b = Backoff::with_seed(Duration::from_millis(100), Duration::from_secs(2), 2.0, 7);
        assert_eq!(b.base_ms(), 100);
        b.next();
        assert_eq!(b.base_ms(), 200);
        b.next();
        assert_eq!(b.base_ms(), 400);
        b.next();
        assert_eq!(b.base_ms(), 800);
        b.next();
        assert_eq!(b.base_ms(), 1600);
        b.next();
        assert_eq!(b.base_ms(), 2000, "base caps at max");
        // Pump many attempts; the base must never exceed the cap.
        for _ in 0..40 {
            let _ = b.next();
            assert!(b.base_ms() <= 2000);
        }
        assert_eq!(b.base_ms(), 2000);
    }

    #[test]
    fn each_draw_stays_within_current_base() {
        let mut b = Backoff::with_seed(Duration::from_millis(100), Duration::from_secs(1), 2.0, 11);
        for _ in 0..20 {
            let base = b.base_ms();
            let draw = b.next().as_millis() as u64;
            assert!(draw <= base, "draw {draw} must be <= base {base}");
        }
    }

    #[test]
    fn draws_stay_within_bounds_and_spread() {
        let mut b = Backoff::with_seed(Duration::from_millis(100), Duration::from_secs(1), 2.0, 42);
        let mut seen_min = u64::MAX;
        let mut seen_max = 0u64;
        for _ in 0..500 {
            let d = b.next().as_millis() as u64;
            assert!(d <= b.base_ms());
            assert!(d <= 1000);
            seen_min = seen_min.min(d);
            seen_max = seen_max.max(d);
        }
        // Full jitter means the very first window already produces spread.
        assert!(seen_min == 0, "full jitter must sometimes draw 0");
        assert!(seen_max >= 100, "jitter must produce non-trivial spread");
    }

    #[test]
    fn deterministic_with_same_seed() {
        let mut a = Backoff::with_seed(Duration::from_secs(1), Duration::from_secs(60), 2.0, 99);
        let mut b = Backoff::with_seed(Duration::from_secs(1), Duration::from_secs(60), 2.0, 99);
        for _ in 0..20 {
            assert_eq!(a.next(), b.next());
        }
    }

    #[test]
    fn reset_restarts_attempts() {
        let mut b = Backoff::with_seed(Duration::from_millis(100), Duration::from_secs(60), 2.0, 5);
        let _ = b.next();
        let _ = b.next();
        b.reset();
        assert_eq!(b.base_ms(), 100);
    }
}
