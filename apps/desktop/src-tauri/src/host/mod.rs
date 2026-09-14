//! Client half of the desktop Host carrier: frame codec, process supervision, and
//! the request bridge that serves the webview's transport hooks.

pub mod bridge;
pub mod client;
pub mod frame;
