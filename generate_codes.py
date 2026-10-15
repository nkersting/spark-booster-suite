import string
import secrets

def generate_segment(length: int) -> str:
    """Generate a random alphanumeric string of uppercase letters and digits."""
    characters = string.ascii_uppercase + string.digits
    return ''.join(secrets.choice(characters) for _ in range(length))

def generate_formatted_code() -> str:
    """Generate a 16-character code in XX-XXXX-XXXXX-XXXXX format."""
    return f"{generate_segment(2)}-{generate_segment(4)}-{generate_segment(5)}-{generate_segment(5)}"

def generate_codes_to_csv(n: int, filename: str = "codes.csv"):
    """Generate N unique codes and save to a single-column CSV without a header."""
    unique_codes = set()
    
    # Ensure all N generated codes are unique
    while len(unique_codes) < n:
        unique_codes.add(generate_formatted_code())
        
    # Write directly to file (one code per line)
    with open(filename, mode='w', encoding='utf-8') as f:
        for code in unique_codes:
            f.write(f"{code}\n")
            
    print(f"Successfully generated {n} unique codes to '{filename}'.")

if __name__ == "__main__":
    N = 10000  # Set your desired count here
    generate_codes_to_csv(n=N, filename="generated_codes.csv")
