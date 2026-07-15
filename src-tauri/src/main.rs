//! Tauri 2.0 言落 (Yanluo) — Main Entry Point
//!
//! Logic lives in lib.rs. This file just calls into it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    asr_workshop_lib::main()
}
