//! Text recognition for scanned PDFs with the Tesseract that ships next to this program.
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const MAX_OCR_PAGES: usize = 200;
pub const OCR_LANGS: &str = "kor+eng";
/// a page taller than this (pixels at 300 dpi) is scaled down, so one long page cannot exhaust memory
pub const MAX_RENDER_HEIGHT: i32 = 10_000;
const DPI: f32 = 300.0;
const PAGE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq)]
pub struct TesseractPaths {
    pub exe: PathBuf,
    pub tessdata: PathBuf,
}

/// LLM_WIKI_TESSERACT_DIR when set, else `<exe dir>/tesseract`; only a folder that has the
/// executable and both languages' data counts.
pub fn find_tesseract(env_dir: Option<&str>, exe_dir: Option<&Path>) -> Option<TesseractPaths> {
    let dir = match env_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => exe_dir?.join("tesseract"),
    };
    let exe = dir.join("tesseract.exe");
    let tessdata = dir.join("tessdata");
    let has_data = ["kor", "eng"]
        .iter()
        .all(|l| tessdata.join(format!("{l}.traineddata")).is_file());
    if exe.is_file() && has_data {
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

/// `tesseract page-N.png page-N -l kor+eng --psm 4`, run inside the work folder: the text lands in
/// `page-N.txt`. Relative names keep a Hangul temp path out of Tesseract's ANSI command line on a
/// Windows that is not set to Korean. Layout mode 4 (one column of text of varying sizes) read real
/// Korean pages best (93-99% of the characters); the automatic mode 3 lost most of some pages.
pub fn tesseract_args(page_no: usize) -> Vec<OsString> {
    vec![
        format!("page-{page_no}.png").into(),
        format!("page-{page_no}").into(),
        "-l".into(),
        OCR_LANGS.into(),
        "--psm".into(),
        "4".into(),
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

/// (target width, maximum height) for rendering a page; pdfium scales the page down to fit both
pub fn render_size(width_pt: f32, _height_pt: f32) -> (i32, i32) {
    (render_width(width_pt), MAX_RENDER_HEIGHT)
}

type Slot = Arc<(Mutex<Option<Result<String, String>>>, Condvar)>;
static IN_FLIGHT: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();

/// Run `f` once for a key while it is running: a second caller for the same file (preprocess and
/// ingest both reading a fresh scan) waits for the first run's result instead of reading it again.
/// Nothing is remembered after the run; the file cache does that.
pub fn once_per_key<F>(key: &str, f: F) -> Result<String, String>
where
    F: FnOnce() -> Result<String, String>,
{
    let map = IN_FLIGHT.get_or_init(Default::default);
    let (slot, leader) = {
        let mut m = map.lock().unwrap_or_else(|e| e.into_inner());
        match m.get(key) {
            Some(s) => (s.clone(), false),
            None => {
                let s: Slot = Arc::new((Mutex::new(None), Condvar::new()));
                m.insert(key.to_string(), s.clone());
                (s, true)
            }
        }
    };
    let (cell, ready) = &*slot;
    if leader {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
            .unwrap_or_else(|_| Err("OCR stopped unexpectedly".to_string()));
        *cell.lock().unwrap_or_else(|e| e.into_inner()) = Some(result.clone());
        ready.notify_all();
        map.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
        result
    } else {
        let mut done = cell.lock().unwrap_or_else(|e| e.into_inner());
        while done.is_none() {
            done = ready.wait(done).unwrap_or_else(|e| e.into_inner());
        }
        done.clone()
            .unwrap_or_else(|| Err("OCR result missing".to_string()))
    }
}

fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<(), String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("tesseract did not start: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("tesseract exited with {status}")),
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("tesseract timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("tesseract could not be waited for: {e}")),
        }
    }
}

/// [`ocr_pdf_with_tesseract`] once per file at a time (see [`once_per_key`])
pub fn ocr_pdf_once(pdf_path: &str, t: &TesseractPaths) -> Result<String, String> {
    once_per_key(pdf_path, || ocr_pdf_with_tesseract(pdf_path, t))
}

/// Render every page (up to MAX_OCR_PAGES) at 300 dpi and read it with Tesseract. Every pdfium call
/// holds the pdfium lock (pdfium is not safe across threads); Tesseract runs without it. A page that
/// fails is left empty and named in the log; when no page could be read the result is an error, so
/// the caller can try other tools and nothing empty is cached. The work folder is always removed.
pub fn ocr_pdf_with_tesseract(pdf_path: &str, t: &TesseractPaths) -> Result<String, String> {
    use pdfium_render::prelude::*;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let work = std::env::temp_dir().join(format!("llm-wiki-ocr-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&work).map_err(|e| format!("no temporary folder for OCR: {e}"))?;

    let result = (|| -> Result<String, String> {
        let guard = crate::commands::fs::lock_pdfium();
        let pdfium = crate::commands::fs::pdfium()?;
        let doc = pdfium
            .load_pdf_from_file(pdf_path, None)
            .map_err(|e| format!("pdfium could not open the PDF: {e}"))?;
        let total = doc.pages().len().max(0) as usize;
        let count = total.min(MAX_OCR_PAGES);
        if total > MAX_OCR_PAGES {
            eprintln!("[ocr] only the first {MAX_OCR_PAGES} pages are read");
        }
        drop(guard);

        let mut pages = Vec::with_capacity(count);
        let mut read = 0usize;
        let mut first_error: Option<String> = None;
        for i in 0..count {
            let page_no = i + 1;
            let one = || -> Result<String, String> {
                // pdfium work under the lock; the page is dropped before the lock is released
                let image = {
                    let _g = crate::commands::fs::lock_pdfium();
                    let page = doc
                        .pages()
                        .get(i as PdfPageIndex)
                        .map_err(|e| format!("page: {e}"))?;
                    let (width, max_height) = render_size(page.width().value, page.height().value);
                    let config = PdfRenderConfig::new()
                        .set_target_width(width)
                        .set_maximum_height(max_height);
                    let image = page
                        .render_with_config(&config)
                        .map_err(|e| format!("render: {e}"))?
                        .as_image()
                        .map_err(|e| format!("image: {e}"))?;
                    drop(page);
                    image
                };
                let png = work.join(format!("page-{page_no}.png"));
                image
                    .save_with_format(&png, image::ImageFormat::Png)
                    .map_err(|e| format!("png: {e}"))?;
                drop(image);
                let mut cmd = Command::new(&t.exe);
                cmd.args(tesseract_args(page_no))
                    .current_dir(&work)
                    .env("TESSDATA_PREFIX", &t.tessdata)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                crate::commands::fs::hide_console(&mut cmd);
                let ran = run_with_timeout(&mut cmd, PAGE_TIMEOUT);
                let _ = std::fs::remove_file(&png);
                ran?;
                let txt = work.join(format!("page-{page_no}.txt"));
                let text = std::fs::read_to_string(&txt).map_err(|e| format!("output: {e}"));
                let _ = std::fs::remove_file(&txt);
                text
            };
            match one() {
                Ok(text) => {
                    read += 1;
                    pages.push(text);
                }
                Err(e) => {
                    eprintln!("[ocr] page {page_no} skipped: {e}");
                    first_error.get_or_insert(e);
                    pages.push(String::new());
                }
            }
        }
        {
            let _g = crate::commands::fs::lock_pdfium();
            drop(doc);
        }
        if read == 0 {
            return Err(format!(
                "tesseract read no page: {}",
                first_error.unwrap_or_else(|| "the PDF has no pages".into())
            ));
        }
        Ok(assemble_pages(&pages))
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
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
        fs::write(dir.join("tessdata").join("eng.traineddata"), b"x").unwrap();
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
    fn a_folder_without_the_english_data_does_not_count() {
        let d = temp_dir("noeng");
        fake_install(&d);
        fs::remove_file(d.join("tessdata").join("eng.traineddata")).unwrap();
        assert!(find_tesseract(d.to_str(), None).is_none());
    }

    #[test]
    fn finds_tesseract_under_a_hangul_folder() {
        let d = temp_dir("한글폴더");
        fake_install(&d);
        assert!(find_tesseract(d.to_str(), None).is_some());
    }

    #[test]
    fn the_command_line_reads_korean_and_english_in_single_column_layout() {
        // relative names: tesseract runs inside the work folder, so a Hangul temp path never
        // goes through its ANSI command line
        let args = tesseract_args(7);
        let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["page-7.png", "page-7", "-l", "kor+eng", "--psm", "4"]);
    }

    #[test]
    fn pages_become_numbered_sections_and_empty_pages_stay_numbered() {
        let text = assemble_pages(&["  첫 쪽\n".to_string(), String::new(), "셋째".to_string()]);
        assert_eq!(text, "## Page 1\n\n첫 쪽\n\n## Page 2\n\n\n\n## Page 3\n\n셋째\n\n");
    }

    #[test]
    fn a_very_tall_page_is_bounded_in_height() {
        assert_eq!(render_size(595.0, 842.0), (2479, MAX_RENDER_HEIGHT));
        assert_eq!(render_size(595.0, 14_400.0), (2479, MAX_RENDER_HEIGHT));
        assert!(MAX_RENDER_HEIGHT <= 10_000);
    }

    #[test]
    fn concurrent_calls_for_one_file_share_one_run() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Barrier};
        let runs = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(3));
        let handles: Vec<_> = (0..3)
            .map(|_| {
                let runs = runs.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    once_per_key("C:/w/raw/sources/same.pdf", || {
                        runs.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(300));
                        Ok("text".to_string())
                    })
                })
            })
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap().unwrap(), "text");
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        // the run is not remembered once it has finished: a later call runs again
        once_per_key("C:/w/raw/sources/same.pdf", || {
            runs.fetch_add(1, Ordering::SeqCst);
            Ok(String::new())
        })
        .unwrap();
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_panicking_run_is_an_error_for_everyone_waiting() {
        let r = once_per_key("C:/w/raw/sources/broken.pdf", || panic!("boom"));
        assert!(r.is_err());
    }

    /// Needs pdfium (PDFIUM_DYNAMIC_LIB_PATH); a tesseract.exe that cannot start fails every page.
    #[test]
    fn a_run_where_no_page_could_be_read_is_an_error() {
        if std::env::var("PDFIUM_DYNAMIC_LIB_PATH").is_err() {
            eprintln!("skipped: PDFIUM_DYNAMIC_LIB_PATH is not set");
            return;
        }
        let d = temp_dir("broken");
        fake_install(&d); // tesseract.exe is a text file: it cannot start
        let t = find_tesseract(d.to_str(), None).unwrap();
        let pdf = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/scanned-ko.pdf");
        let r = ocr_pdf_with_tesseract(pdf, &t);
        assert!(r.is_err(), "expected an error, got {r:?}");
    }

    #[test]
    fn pages_render_at_300_dpi_within_bounds() {
        assert_eq!(render_width(595.0), 2479); // A4 width in points
        assert_eq!(render_width(1.0), 200);
        assert_eq!(render_width(100_000.0), 6000);
    }

    /// Runs only where a real Tesseract is given (LLM_WIKI_TESSERACT_DIR) and pdfium can load
    /// (PDFIUM_DYNAMIC_LIB_PATH); otherwise it reports the skip and passes.
    #[test]
    fn reads_korean_and_english_from_an_image_only_pdf() {
        let Some(t) = std::env::var("LLM_WIKI_TESSERACT_DIR")
            .ok()
            .and_then(|d| find_tesseract(Some(&d), None))
        else {
            eprintln!("skipped: LLM_WIKI_TESSERACT_DIR is not set");
            return;
        };
        let pdf = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/scanned-ko.pdf");
        let text = ocr_pdf_with_tesseract(pdf, &t).expect("ocr");
        assert!(text.starts_with("## Page 1"));
        assert!(text.contains("## Page 2"));
        // one Hangul syllable may be misread (빛/빚), so check whole words that come out stable
        assert!(text.contains("회사소개"), "got: {text}");
        assert!(text.contains("2009"), "got: {text}");
    }

    /// pdfium is not safe across threads: OCR must take the same lock as every other pdfium caller.
    /// Two OCR runs and a text extraction at the same time must all finish (no crash, no error).
    #[test]
    fn ocr_and_text_extraction_can_run_at_the_same_time() {
        let Some(t) = std::env::var("LLM_WIKI_TESSERACT_DIR")
            .ok()
            .and_then(|d| find_tesseract(Some(&d), None))
        else {
            eprintln!("skipped: LLM_WIKI_TESSERACT_DIR is not set");
            return;
        };
        let pdf = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/scanned-ko.pdf");
        let mut handles = Vec::new();
        for _ in 0..2 {
            let t = t.clone();
            handles.push(std::thread::spawn(move || {
                ocr_pdf_with_tesseract(pdf, &t).map(|_| ())
            }));
        }
        handles.push(std::thread::spawn(move || {
            for _ in 0..20 {
                crate::commands::extract_images::extract_pdf_markdown(
                    pdf,
                    None,
                    "",
                    &crate::commands::extract_images::ExtractOptions::default(),
                )?;
            }
            Ok(())
        }));
        for h in handles {
            h.join().expect("thread").expect("finished without an error");
        }
    }
}
