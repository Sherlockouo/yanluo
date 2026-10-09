//! Tauri 2.0 Sayi — Main Entry Point
//!
//! Logic lives in lib.rs. This file just calls into it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sayi_lib::main()
}
