use meshcraft_rust_engine::{compile_axis_block_rust, AxisCompilationInput, CompiledAxisOutput};
use std::io::{self, Read};

fn main() {
    let mut buffer = String::new();
    if let Err(err) = io::stdin().read_to_string(&mut buffer) {
        eprintln!("Failed to read stdin: {}", err);
        std::process::exit(1);
    }

    let trimmed = buffer.trim();
    if trimmed.is_empty() {
        eprintln!("Empty stdin payload");
        std::process::exit(1);
    }

    if trimmed.starts_with('[') {
        let inputs: Vec<AxisCompilationInput> = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(err) => {
                eprintln!("Invalid AxisCompilationInput[] JSON: {}", err);
                std::process::exit(1);
            }
        };
        let outputs: Vec<CompiledAxisOutput> =
            inputs.iter().map(compile_axis_block_rust).collect();
        match serde_json::to_string(&outputs) {
            Ok(json) => println!("{}", json),
            Err(err) => {
                eprintln!("Failed to serialize outputs: {}", err);
                std::process::exit(1);
            }
        }
    } else {
        let input: AxisCompilationInput = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(err) => {
                eprintln!("Invalid AxisCompilationInput JSON: {}", err);
                std::process::exit(1);
            }
        };
        let output = compile_axis_block_rust(&input);
        match serde_json::to_string(&output) {
            Ok(json) => println!("{}", json),
            Err(err) => {
                eprintln!("Failed to serialize output: {}", err);
                std::process::exit(1);
            }
        }
    }
}
