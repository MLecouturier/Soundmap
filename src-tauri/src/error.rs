use serde::Serialize;
use std::collections::HashMap;

/// Structured application error, sent to the frontend so it can be
/// translated into the user's chosen language.
///
/// `code` is a stable identifier (e.g. "synth_not_found") matching a key in
/// the frontend's i18n error dictionary (`errors.<code>`). `params` carries
/// optional values to interpolate into the translated message (e.g. `{id}`).
///
/// Backend code must never embed human-readable, language-specific text in
/// errors returned to the frontend: only stable codes and raw parameters.
#[derive(Serialize, Debug)]
pub struct AppError {
    pub code: String,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub params: HashMap<String, String>,
}

impl AppError {
    /// Creates an error with no interpolation parameters.
    pub fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
            params: HashMap::new(),
        }
    }

    /// Adds a parameter to interpolate into the translated message.
    pub fn with_param(mut self, key: &str, value: impl ToString) -> Self {
        self.params.insert(key.to_string(), value.to_string());
        self
    }
}

/// Shorthand to build an `Err(AppError)` from a code, e.g. `err("no_image_loaded")`.
pub fn err(code: &str) -> AppError {
    AppError::new(code)
}
