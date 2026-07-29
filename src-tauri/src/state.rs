use image::DynamicImage;
use std::sync::Mutex;

pub struct ImageState {
    pub original: Mutex<Option<DynamicImage>>,
    pub processed: Mutex<Option<DynamicImage>>,
}

impl Default for ImageState {
    fn default() -> Self {
        Self {
            original: Mutex::new(None),
            processed: Mutex::new(None),
        }
    }
}