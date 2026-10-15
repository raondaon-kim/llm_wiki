use std::env;

/// LLM_WIKI_MANAGED=1: another program (GenOffice) starts and stops this one.
pub fn is_managed() -> bool {
    parse_flag(env::var("LLM_WIKI_MANAGED").ok().as_deref())
}

pub fn parse_flag(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1") | Some("true") | Some("yes"))
}

/// A usable local port (1024 or higher), else the default.
pub fn parse_port(value: Option<&str>, default: u16) -> u16 {
    value
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(default)
}

pub fn clip_port() -> u16 {
    parse_port(env::var("LLM_WIKI_CLIP_PORT").ok().as_deref(), 19827)
}

pub fn api_port() -> u16 {
    parse_port(env::var("LLM_WIKI_API_PORT").ok().as_deref(), 19828)
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub managed: bool,
    pub clip_port: u16,
    pub api_port: u16,
}

pub fn runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        managed: is_managed(),
        clip_port: clip_port(),
        api_port: api_port(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_managed_flag_accepts_1_true_yes_only() {
        assert!(parse_flag(Some("1")));
        assert!(parse_flag(Some(" true ")));
        assert!(parse_flag(Some("yes")));
        assert!(!parse_flag(Some("0")));
        assert!(!parse_flag(Some("")));
        assert!(!parse_flag(None));
    }

    #[test]
    fn ports_below_1024_or_garbage_fall_back_to_the_default() {
        assert_eq!(parse_port(Some("51234"), 19828), 51234);
        assert_eq!(parse_port(Some(" 51234 "), 19828), 51234);
        assert_eq!(parse_port(Some("80"), 19828), 19828);
        assert_eq!(parse_port(Some("70000"), 19828), 19828);
        assert_eq!(parse_port(Some("abc"), 19828), 19828);
        assert_eq!(parse_port(None, 19828), 19828);
    }
}
