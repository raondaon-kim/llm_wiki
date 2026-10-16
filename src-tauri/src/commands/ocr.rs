//! Text recognition for scanned PDFs with the Tesseract that ships next to this program.
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const MAX_OCR_PAGES: usize = 200;
pub const OCR_LANGS: &str = "kor+eng";
const DPI: f32 = 300.0;

#[derive(Debug, Clone, PartialEq)]
pub struct TesseractPaths {
    pub exe: PathBuf,
    pub tessdata: PathBuf,
}

/// LLM_WIKI_TESSERACT_DIR when set, else `<exe dir>/tesseract`; only a folder that has the
/// executable and the Korean data counts.
pub fn find_tesseract(env_dir: Option<&str>, exe_dir: Option<&Path>) -> Option<TesseractPaths> {
    let dir = match env_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => exe_dir?.join("tesseract"),
    };
    let exe = dir.join("tesseract.exe");
    let tessdata = dir.join("tessdata");
    if exe.is_file() && tessdata.join("kor.traineddata").is_file() {
        Some(TesseractPaths { exe, tessdata })
    } else {
        None
    }
}

/// the Tesseract this process can use: the env override or the folder next to the executable
pub fn bundled_tesseract() -> Option<TesseractPaths> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    find_tesseract(
        std::env::var("LLM_WIKI_TESSERACT_DIR").ok().as_deref(),
        exe_dir.as_deref(),
    )
}

/// `tesseract <image> <outbase> -l kor+eng --psm 3`: the text lands in `<outbase>.txt`
pub fn tesseract_args(image: &Path, out_base: &Path) -> Vec<OsString> {
    vec![
        image.into(),
        out_base.into(),
        "-l".into(),
        OCR_LANGS.into(),
        "--psm".into(),
        "3".into(),
    ]
}

/// the pages as `## Page N` sections, the shape the text path returns
pub fn assemble_pages(pages: &[String]) -> String {
    let mut out = String::new();
    for (i, text) in pages.iter().enumerate() {
        out.push_str(&format!("## Page {}\n\n{}\n\n", i + 1, text.trim()));
    }
    out
}

/// pixel width for a page `width_pt` points wide at 300 dpi, kept between 200 and 6000
pub fn render_width(width_pt: f32) -> i32 {
    ((width_pt / 72.0) * DPI).round().clamp(200.0, 6000.0) as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let d = std::env::temp_dir().join(format!("ocr-test-{tag}-{nanos}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_install(dir: &Path) {
        fs::create_dir_all(dir.join("tessdata")).unwrap();
        fs::write(dir.join("tesseract.exe"), b"x").unwrap();
        fs::write(dir.join("tessdata").join("kor.traineddata"), b"x").unwrap();
    }

    #[test]
    fn finds_tesseract_from_the_env_folder_first_then_next_to_the_exe() {
        let env_dir = temp_dir("env");
        fake_install(&env_dir);
        let exe_dir = temp_dir("exe");
        fake_install(&exe_dir.join("tesseract"));
        let from_env = find_tesseract(env_dir.to_str(), Some(&exe_dir)).unwrap();
        assert_eq!(from_env.exe, env_dir.join("tesseract.exe"));
        assert_eq!(from_env.tessdata, env_dir.join("tessdata"));
        let beside = find_tesseract(None, Some(&exe_dir)).unwrap();
        assert_eq!(beside.exe, exe_dir.join("tesseract").join("tesseract.exe"));
        assert_eq!(find_tesseract(Some("  "), Some(&exe_dir)).unwrap(), beside);
    }

    #[test]
    fn a_folder_without_the_korean_data_does_not_count() {
        let d = temp_dir("nokor");
        fs::write(d.join("tesseract.exe"), b"x").unwrap();
        assert!(find_tesseract(d.to_str(), None).is_none());
        assert!(find_tesseract(None, None).is_none());
    }

    #[test]
    fn finds_tesseract_under_a_hangul_folder() {
        let d = temp_dir("한글폴더");
        fake_install(&d);
        assert!(find_tesseract(d.to_str(), None).is_some());
    }

    #[test]
    fn the_command_line_reads_korean_and_english_with_automatic_layout() {
        let args = tesseract_args(Path::new("C:/t/page-1.png"), Path::new("C:/t/page-1"));
        let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["C:/t/page-1.png", "C:/t/page-1", "-l", "kor+eng", "--psm", "3"]);
    }

    #[test]
    fn pages_become_numbered_sections_and_empty_pages_stay_numbered() {
        let text = assemble_pages(&["  첫 쪽\n".to_string(), String::new(), "셋째".to_string()]);
        assert_eq!(text, "## Page 1\n\n첫 쪽\n\n## Page 2\n\n\n\n## Page 3\n\n셋째\n\n");
    }

    #[test]
    fn pages_render_at_300_dpi_within_bounds() {
        assert_eq!(render_width(595.0), 2479); // A4 width in points
        assert_eq!(render_width(1.0), 200);
        assert_eq!(render_width(100_000.0), 6000);
    }
}
