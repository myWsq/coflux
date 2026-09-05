//! daemon 日志行的统一入口：[`logln!`] 在每行前面加本地时间戳。
//!
//! macOS 上 daemon.log 是 launchd 把 supervisor/worker 的 stderr 原样追加进去的（见
//! `packages/cli/cofluxd.mjs` 的 StandardErrorPath），没有任何外层加时间；Linux 走 journald 本身
//! 带时间。裸 `eprintln!` 的结果是排查时只知道"刷了 8 万行"，不知道从哪天开始、每分钟几条。
//!
//! 刻意不引 chrono/time/tracing：daemon 的依赖面是发布产物大小与交叉编译面，纪元秒→年月日的
//! 换算二十行手写即可（Howard Hinnant 的 civil_from_days）；本地时区偏移用 libc `localtime_r`
//! 取 `tm_gmtoff`，用户在本机读日志时不必心算 UTC。
//!
//! 格式：`2026-09-06T01:09:39.123+08:00 [worker] ...`——ISO 8601、毫秒、带偏移，`sort` 即按时间序，
//! 各语言解析器都认。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 在 `eprintln!` 之前加本地时间戳；参数与 `eprintln!` 完全一致。
///
/// 只用于 daemon 进程（supervisor/worker）落 daemon.log 的日志行。子命令的用法错误提示
/// （如 `--log-sink` 缺参数）面向调用方的 stderr，仍用裸 `eprintln!`。
#[macro_export]
macro_rules! logln {
    ($($arg:tt)*) => {
        ::std::eprintln!("{} {}", $crate::logline::timestamp(), ::std::format_args!($($arg)*))
    };
}

/// 当前本地时间，ISO 8601 毫秒精度并带时区偏移，例如 `2026-09-06T01:09:39.123+08:00`。
pub fn timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    let epoch_secs = now.as_secs() as i64;
    format_timestamp(
        epoch_secs,
        now.subsec_millis(),
        local_offset_seconds(epoch_secs),
    )
}

/// 纯函数：纪元秒 + 毫秒 + 时区偏移（秒）→ ISO 8601 文本。偏移可为负；`epoch_secs` 可为 1970 之前。
pub fn format_timestamp(epoch_secs: i64, millis: u32, offset_secs: i32) -> String {
    let local = epoch_secs + i64::from(offset_secs);
    let days = local.div_euclid(86_400);
    let secs_of_day = local.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3_600;
    let minute = secs_of_day % 3_600 / 60;
    let second = secs_of_day % 60;
    let sign = if offset_secs < 0 { '-' } else { '+' };
    let offset = offset_secs.unsigned_abs();
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}{sign}{:02}:{:02}",
        offset / 3_600,
        offset % 3_600 / 60,
    )
}

/// 自 1970-01-01 起的天数 → 公历 (年, 月, 日)。Howard Hinnant, "chrono-Compatible Low-Level Date
/// Algorithms"，对负天数同样成立。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]，3 月为 0
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// 该时刻本地时区相对 UTC 的偏移（秒）。`localtime_r` 线程安全且尊重 DST；失败退回 0（即 UTC）。
#[cfg(unix)]
fn local_offset_seconds(epoch_secs: i64) -> i32 {
    let time: libc::time_t = epoch_secs as libc::time_t;
    // SAFETY: `tm` 是 plain-old-data，全零是合法初值；`localtime_r` 只写入我们独占的 `tm`，
    // 返回空指针即失败，不读 `tm`。
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let filled = unsafe { libc::localtime_r(&time, &mut tm) };
    if filled.is_null() {
        0
    } else {
        tm.tm_gmtoff as i32
    }
}

#[cfg(not(unix))]
fn local_offset_seconds(_epoch_secs: i64) -> i32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_is_1970_utc() {
        assert_eq!(format_timestamp(0, 0, 0), "1970-01-01T00:00:00.000+00:00");
    }

    #[test]
    fn positive_offset_crosses_midnight() {
        // 2026-09-05T17:09:39Z 在东八区是次日 01:09:39。
        assert_eq!(
            format_timestamp(1_788_628_179, 123, 8 * 3_600),
            "2026-09-06T01:09:39.123+08:00"
        );
    }

    #[test]
    fn negative_offset_and_half_hour_zone() {
        // UTC 2000-03-01T02:00:00 在 -03:30（纽芬兰标准时）是 2 月 29 日（闰年）22:30。
        assert_eq!(
            format_timestamp(951_876_000, 0, -(3 * 3_600 + 1_800)),
            "2000-02-29T22:30:00.000-03:30"
        );
    }

    #[test]
    fn leap_years_and_century_rule() {
        // 2100 不是闰年：2100-02-28 的下一天是 3 月 1 日。
        assert_eq!(civil_from_days(47_540), (2100, 2, 28));
        assert_eq!(civil_from_days(47_541), (2100, 3, 1));
        // 2000 是闰年：2000-02-29 存在。
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }

    #[test]
    fn before_epoch() {
        assert_eq!(
            format_timestamp(-1, 999, 0),
            "1969-12-31T23:59:59.999+00:00"
        );
    }

    #[test]
    fn live_timestamp_has_expected_shape() {
        let text = timestamp();
        // YYYY-MM-DDTHH:MM:SS.mmm±HH:MM = 29 字符
        assert_eq!(text.len(), 29, "{text}");
        assert_eq!(&text[10..11], "T");
        assert!(
            text.ends_with(":00") || text.ends_with(":30") || text.ends_with(":45"),
            "{text}"
        );
    }
}
