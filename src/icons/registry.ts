import type { LucideIcon } from 'lucide-react'
import {
  Activity, AirVent, Apple, Archive, Armchair,
  Award, Baby, Backpack, Bath, Battery,
  Bed, Beer, Bike, Bird, Book,
  Briefcase, Brush, Bus, Calendar, Cake,
  Car, Carrot, Cat, ChefHat, Clock,
  Coffee, Compass, Cookie, CookingPot, CupSoda,
  Dog, Drill, Droplets, Dumbbell, Egg,
  Fish, Flame, Flower, Flower2, Footprints,
  Fuel, Gauge, Gift, GlassWater, Globe,
  GraduationCap, Hammer, Headphones, Heart, Home,
  IceCream, Inbox, Key, Lamp, Leaf,
  Lightbulb, Lock, Mail, Map, Medal,
  Milk, Monitor, Moon, Mountain, Music,
  Navigation, Package, Paintbrush, Paintbrush2, PawPrint,
  PersonStanding, Phone, Pill, Pizza, Plug,
  Rabbit, Recycle, Refrigerator, Sandwich, Scissors,
  Shield, Shirt, Shovel, ShowerHead, Smartphone,
  Sofa, Soup, Sparkles, Sprout, Star,
  Stethoscope, Sun, Syringe, Tablet, Tent,
  Thermometer, Toilet, Toolbox, Trash2, TreeDeciduous,
  TreePine, Trophy, Truck, Umbrella, UtensilsCrossed,
  Waves, Wind, Wine, Wrench, Zap,
  WashingMachine,
} from 'lucide-react'

export const ICON_REGISTRY: Record<string, LucideIcon> = {
  // Home & Cleaning
  Home, Sofa, Armchair, Bed, Lamp,
  Bath, ShowerHead, Toilet, Sparkles, Brush,
  Paintbrush, Paintbrush2, WashingMachine, Shirt, Droplets,
  Waves, Wind, Trash2, Recycle, AirVent,
  // Kitchen & Food
  ChefHat, UtensilsCrossed, CookingPot, Refrigerator, Flame,
  Coffee, CupSoda, GlassWater, Milk, Beer, Wine, Soup,
  Pizza, Sandwich, Egg, Cookie, Cake, IceCream, Carrot, Apple,
  // Pets
  Dog, Cat, Fish, Bird, Rabbit, PawPrint,
  // Vehicle & Transport
  Car, Truck, Bus, Bike, Fuel, Gauge,
  // Garden & Outdoors
  Leaf, Sprout, TreePine, TreeDeciduous, Flower, Flower2,
  Shovel, Umbrella, Sun, Moon, Mountain, Tent, Compass,
  // Health & Body
  Heart, Activity, Dumbbell, Stethoscope, Thermometer, Pill,
  Syringe, PersonStanding, Footprints,
  // Tools & Maintenance
  Wrench, Hammer, Drill, Toolbox, Scissors, Zap,
  Lightbulb, Plug, Battery,
  // General & Lifestyle
  Calendar, Clock, Star, Globe, Map, Navigation,
  Book, Archive, Inbox, Mail, Phone, Smartphone, Tablet, Monitor,
  Headphones, Music, Gift, Trophy, Medal, Award,
  Baby, GraduationCap, Briefcase, Backpack, Package,
  Lock, Key, Shield,
}

export const ICON_NAMES = Object.keys(ICON_REGISTRY)
