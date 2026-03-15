use wasm_bindgen::prelude::*;
use std::collections::HashMap;

#[wasm_bindgen]
pub struct ProbabilityDist {
    pub_levels: HashMap<i32, f64>,
}

#[wasm_bindgen]
impl ProbabilityDist {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            pub_levels: HashMap::new(),
        }
    }

    pub fn get_prob(&self, level: i32) -> f64 {
        *self.pub_levels.get(&level).unwrap_or(&0.0)
    }

    pub fn get_levels(&self) -> Vec<i32> {
        self.pub_levels.keys().cloned().collect()
    }
}

#[wasm_bindgen]
pub fn calculate_modified_level_dist(
    xp: i32,
    enchantability: i32,
    div: i32,
    rng_range: f64,
) -> ProbabilityDist {
    if enchantability <= 0 {
        let mut dist = HashMap::new();
        dist.insert(xp, 1.0);
        return ProbabilityDist { pub_levels: dist };
    }

    let n = (enchantability / div) + 1;
    let n_f = n as f64;
    
    let mut base_dist: HashMap<i32, f64> = HashMap::new();
    let weight = 1.0 / (n_f * n_f);
    
    for i in 0..n {
        for j in 0..n {
            let val = xp + i + j + 1;
            *base_dist.entry(val).or_insert(0.0) += weight;
        }
    }

    let mut final_dist: HashMap<i32, f64> = HashMap::new();
    let steps = 25;
    let steps_f = steps as f64;
    let step_weight = 1.0 / (steps_f * steps_f);

    for (base, b_prob) in base_dist {
        let base_f = base as f64;
        for i in 0..steps {
            for j in 0..steps {
                let bonus = (i as f64 / (steps_f - 1.0) * rng_range) 
                          + (j as f64 / (steps_f - 1.0) * rng_range) 
                          - rng_range;
                let mod_val = (base_f * (1.0 + bonus) + 0.5).floor() as i32;
                let final_mod_val = if mod_val < 1 { 1 } else { mod_val };
                *final_dist.entry(final_mod_val).or_insert(0.0) += b_prob * step_weight;
            }
        }
    }

    ProbabilityDist {
        pub_levels: final_dist,
    }
}
