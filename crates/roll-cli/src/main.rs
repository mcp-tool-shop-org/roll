#![forbid(unsafe_code)]

use std::io;
use std::process;

fn main() {
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();
    let code = roll_cli::run_cli(std::env::args_os(), &mut stdout, &mut stderr);
    process::exit(code as i32);
}
