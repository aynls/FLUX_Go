use std::{future::Future, sync::Arc};

pub type Reporter = Arc<dyn Fn(&str, Option<&str>, Option<usize>, Option<&str>) + Send + Sync>;
tokio::task_local! { static REPORTER: Reporter; }

pub async fn with_reporter<F: Future>(reporter: Reporter, work: F) -> F::Output {
    REPORTER.scope(reporter, work).await
}
/// Task-local reporting prevents concurrent requests and tests from sharing a listener.
pub fn report(phase: &str, task_id: Option<&str>, completed: Option<usize>, status: Option<&str>) {
    let _ = REPORTER.try_with(|listener| listener(phase, task_id, completed, status));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[tokio::test]
    async fn concurrent_reporters_do_not_leak_events_between_requests() {
        let a = Arc::new(Mutex::new(Vec::new()));
        let b = Arc::new(Mutex::new(Vec::new()));
        let sink_a = a.clone();
        let sink_b = b.clone();
        tokio::join!(
            with_reporter(
                Arc::new(move |phase, _, _, _| sink_a.lock().unwrap().push(phase.to_owned())),
                async {
                    report("queued", Some("a"), None, None);
                    tokio::task::yield_now().await;
                    report("downloading", Some("a"), None, None);
                }
            ),
            with_reporter(
                Arc::new(move |phase, _, _, _| sink_b.lock().unwrap().push(phase.to_owned())),
                async {
                    report("waiting", Some("b"), None, None);
                    tokio::task::yield_now().await;
                    report("saving", Some("b"), None, None);
                }
            )
        );
        report("unscoped", None, None, None);
        assert_eq!(*a.lock().unwrap(), vec!["queued", "downloading"]);
        assert_eq!(*b.lock().unwrap(), vec!["waiting", "saving"]);
    }
}
